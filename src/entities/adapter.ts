/**
 * Provider adapter contract — F3 (#6), PRD §12.
 * The interface lives in the entities layer; concrete adapters live in
 * `src/adapters/` (layer 3) and are wired by the composition root.
 */
import type { IR } from './ir.js';
import type { Warning } from './warnings.js';

export type ProviderId = 'copilot' | 'claude' | 'codex' | 'gemini';

export type EmitMode = 'overwrite' | 'merge-key';

export interface EmittedFile {
  /** Repo-relative POSIX path of the target file. */
  path: string;
  body: string;
  /**
   * 'overwrite': the tool fully owns the file (SignedSource header applies).
   * 'merge-key': the tool owns only `mergeKey` in a co-owned file
   * (e.g. `hooks` in `.claude/settings.json`); all other keys are preserved.
   */
  mode: EmitMode;
  /**
   * Required when mode is 'merge-key': the key the tool owns. A dot denotes
   * nesting (`context.fileName` owns only `fileName` inside the top-level
   * `context` object — sibling `context.*` keys are preserved).
   */
  mergeKey?: string;
}

export type Surface = 'instructions' | 'skills' | 'hooks';

/**
 * 'emitted'  — files written for this surface.
 * 'merged'   — surface lands inside a co-owned file via merge-key, or an
 *              existing provider file already carries the projection (e.g. a
 *              correct `@AGENTS.md` import shim needs no re-emit).
 * 'native'   — nothing emitted by design (provider reads canonical directly).
 * 'skipped'  — nothing emitted: translation was impossible (warned) or the
 *              IR carries no content for this surface.
 */
export type SurfaceStatus = 'emitted' | 'merged' | 'native' | 'skipped';

export interface Projection {
  files: EmittedFile[];
  warnings: Warning[];
  surfaces: Record<Surface, SurfaceStatus>;
}

/**
 * Read-only access to existing provider-owned files (`.claude/settings.json`,
 * `.codex/config.toml`, `CLAUDE.md`, …). This is the seam between the pure
 * adapters and the disk: `RepoSnapshot` carries canonical sources only, so a
 * separate reader supplies provider files for merge decisions, conflict
 * detection, and malformed-config refusal. Tests use `createFileReader`
 * over an in-memory record; the C-series gateways implement it over the
 * real filesystem. Paths are repo-relative POSIX.
 */
export interface ProviderFileReader {
  /** Returns the file content, or `null` when the file does not exist. */
  read(path: string): string | null;
  exists(path: string): boolean;
}

/** Pure in-memory `ProviderFileReader` over a path → content record. */
export function createFileReader(files: Record<string, string>): ProviderFileReader {
  const byPath = new Map(Object.entries(files));
  return {
    read: (path) => byPath.get(path) ?? null,
    exists: (path) => byPath.has(path),
  };
}

export interface ProjectionContext {
  /** Repo root the projection targets; emitted paths are relative to it. */
  cwd: string;
  /** This provider's section of `harness-haircut.config.json`, if any (e.g. `gemini.mode`). */
  providerConfig?: Record<string, unknown>;
  /**
   * Existing provider-owned files, when the caller has them. Adapters treat
   * an absent reader like an empty repo (no provider files exist).
   */
  providerFiles?: ProviderFileReader;
}

export interface FileSnapshot {
  /** Repo-relative POSIX path. */
  path: string;
  content: string;
}

/**
 * Snapshot of a repo's configuration files. The filesystem gateway currently
 * collects canonical sources only — `AGENTS.md` files (any depth) plus the
 * root `.agents/` tree (nested `<dir>/.agents/` directories are not
 * collected). For `detectExisting`, callers may additionally include
 * provider-owned files (`.codex/hooks.json`, `CLAUDE.md`, …) in `files`;
 * adapters scan whatever the snapshot carries (the C-series gateway widens
 * collection accordingly).
 */
export interface RepoSnapshot {
  /** Absolute path of the repo root the snapshot was taken from. */
  root: string;
  files: FileSnapshot[];
  /**
   * Repo-relative POSIX paths of canonical-shaped sources excluded by a
   * `.gitignore` rule (an `AGENTS.md`, or a pruned directory on the
   * `.agents/` path reported with a trailing `/`). The `parseRepo` use case
   * maps these into `HH-W012` warnings so over-ignored canonical content
   * surfaces instead of vanishing silently (F1 follow-up #21, PRD §16).
   * Sorted; absent or empty when nothing canonical was excluded.
   */
  excludedCanonicalPaths?: string[];
}

export interface ExistingProviderConfig {
  providerId: ProviderId;
  /** Repo-relative paths of detected provider-owned config files. */
  paths: string[];
}

export interface ProviderAdapter {
  readonly id: ProviderId;
  project(ir: IR, ctx: ProjectionContext): Projection;
  detectExisting(snapshot: RepoSnapshot): ExistingProviderConfig | null;
}
