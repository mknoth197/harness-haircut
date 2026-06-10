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
  /** Required when mode is 'merge-key': the top-level key the tool owns. */
  mergeKey?: string;
}

export type Surface = 'instructions' | 'skills' | 'hooks';

/**
 * 'emitted'  — files written for this surface.
 * 'merged'   — surface lands inside a co-owned file via merge-key.
 * 'native'   — nothing emitted by design (provider reads canonical directly).
 * 'skipped'  — nothing emitted because translation was impossible (warned).
 */
export type SurfaceStatus = 'emitted' | 'merged' | 'native' | 'skipped';

export interface Projection {
  files: EmittedFile[];
  warnings: Warning[];
  surfaces: Record<Surface, SurfaceStatus>;
}

export interface ProjectionContext {
  /** Repo root the projection targets; emitted paths are relative to it. */
  cwd: string;
  /** This provider's section of `harness-haircut.config.json`, if any (e.g. `gemini.mode`). */
  providerConfig?: Record<string, unknown>;
}

export interface FileSnapshot {
  /** Repo-relative POSIX path. */
  path: string;
  content: string;
}

/**
 * Snapshot of a repo's configuration files. Currently contains canonical
 * sources only — `AGENTS.md` files (any depth) plus the root `.agents/`
 * tree (nested `<dir>/.agents/` directories are not collected). Detection
 * of provider-owned files widens this as the A1–A4 adapters land.
 */
export interface RepoSnapshot {
  /** Absolute path of the repo root the snapshot was taken from. */
  root: string;
  files: FileSnapshot[];
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
