/**
 * `apply` use case — C2 (#12), PRD §7/§9/§10. Layer 2: pure orchestration
 * with injected gateways/adapters. The write half of the system, the inverse
 * of `audit`: it re-runs the same projection pipeline, computes the same
 * per-file status `audit` does, then ACTS on it (writes / merges / skips /
 * blocks). It never calls `process.exit`, never touches stdio, never imports
 * `node:fs`/`node:child_process`; every disk read goes through the injected
 * `FileWriter`/reader and every mutation through `writer.write`. The
 * composition root (layer 4) supplies git, the filesystem, the readline
 * prompt, and maps `exitCode`.
 *
 * Write-decision matrix (per emitted file):
 *
 *   class            disk vs projection            → action
 *   ───────────────  ────────────────────────────  ───────────────────────────
 *   header-bearing   clean                          → skip
 *   (verifyAgainst)  stale (sources changed)        → write
 *                    edited (header BODY_HASH bad)   → prompt; write or block
 *                    unmanaged (no header)          → write (own the path; C3
 *                                                      handles pre-existing
 *                                                      foreign files at init)
 *                    missing                        → write
 *   merge-key        owned key deep-equals proj      → skip
 *                    else                            → shallow-merge owned key,
 *                                                      preserve foreign keys,
 *                                                      write (malformed target
 *                                                      → MalformedProviderConfig
 *                                                      Error, exit 3)
 *   headerless       clean (disk === projection)     → skip
 *   (JSON / shim /   stale (disk === recorded hash)  → write
 *    attachment)     edited (else, or first run)     → prompt; write or block
 *                    missing                        → write
 *
 * Exit codes (PRD §7; choices documented inline):
 *   0  success — files written, or "nothing to do"
 *   1  refused (dirty tree without --allow-dirty), or a blocked `edited` file
 *      under --non-interactive, or an overwrite/overwrite path collision
 *   3  invalid config / malformed merge-key target (propagated DomainError)
 */
import type {
  EmittedFile,
  ProjectionContext,
  ProviderAdapter,
  ProviderFileReader,
  ProviderId,
} from '../entities/adapter.js';
import type { ApplyState } from '../entities/apply-state.js';
import { classifyHeaderless, contentHash } from '../entities/apply-state.js';
import { EmitPathCollisionError, MalformedProviderConfigError } from '../entities/errors.js';
import type { FileWriter } from '../entities/file-writer.js';
import type { IR } from '../entities/ir.js';
import { detectHeaderPlacement, verifyAgainstExpected } from '../entities/signed-source.js';
import type { Warning } from '../entities/warnings.js';

/** The action `apply` decided for one emitted file. */
export type ApplyAction = 'written' | 'skipped' | 'blocked';

export interface FileApply {
  /** Repo-relative POSIX path of the emitted target. */
  path: string;
  providerId: ProviderId;
  action: ApplyAction;
  /**
   * Why the file got its action — drives the human-readable change report.
   * `clean` only ever pairs with `skipped`; `edited` pairs with `written`
   * (confirmed) or `blocked` (declined / --non-interactive).
   */
  reason: 'clean' | 'missing' | 'stale' | 'edited' | 'unmanaged' | 'merge-changed';
  /** For merge-key files, the owned key; absent for fully-owned files. */
  mergeKey?: string;
}

export interface ApplyReport {
  /** One entry per expected emitted file, in projection order. */
  files: FileApply[];
  /** Parse warnings + every adapter's projection warnings, concatenated. */
  warnings: Warning[];
  /** Paths actually written (subset of `files` with action 'written'). */
  written: string[];
  /** Paths skipped because disk already matched. */
  skipped: string[];
  /** Paths blocked: an `edited` file the user did not confirm overwriting. */
  blocked: string[];
  /** True when nothing was (or would be) written. */
  nothingToDo: boolean;
  /** True when this was a `--dry-run` (no writes, no state file touched). */
  dryRun: boolean;
  /** PRD §7: 0 success/nothing-to-do · 1 refused/blocked/collision · 3 invalid config. */
  exitCode: 0 | 1 | 3;
  /** Set when the run refused (dirty tree) — distinct from a write report. */
  refused?: 'dirty-tree';
}

export interface ApplyFlags {
  /** STATE1: run even with a dirty git tree. */
  allowDirty: boolean;
  /** OPT1: compute the full plan but write nothing (and no state file). */
  dryRun: boolean;
  /** UN1: never prompt — an `edited` file fails the run (exit 1). */
  nonInteractive: boolean;
}

export interface ApplyDeps {
  /** Parses the canonical sources into IR + parse warnings (DI from layer 4). */
  parse: () => Promise<{ ir: IR; warnings: Warning[] }>;
  /** Enabled adapters, already filtered by config (`providers_disabled`). */
  adapters: readonly ProviderAdapter[];
  /** Read-only disk access adapters use for merge decisions during projection. */
  reader: ProviderFileReader;
  /** The single mutation surface; also reads disk for the verify step. */
  writer: FileWriter;
  /** Per-provider projection context factory (cwd, providerConfig, reader). */
  contextFor: (id: ProviderId) => ProjectionContext;
  /** STATE1: true when `git status --porcelain` is non-empty (or unverifiable). */
  isDirty: () => Promise<boolean>;
  /** UN1 prompt: resolves true to overwrite an `edited` file, false to skip it. */
  confirm: (path: string) => Promise<boolean>;
  /** Reads + parses the apply state file (headerless edited-vs-stale memory). */
  readState: () => ApplyState;
  /** Persists the apply state file atomically (only on a real, non-dry run). */
  writeState: (state: ApplyState) => void;
  flags: ApplyFlags;
}

/** Resolves a dot-path (`context.fileName`) against a parsed JSON object. */
function resolveOwnedValue(
  root: Record<string, unknown>,
  mergeKey: string,
): { found: boolean; value: unknown } {
  const segments = mergeKey.split('.');
  let current: unknown = root;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      return { found: false, value: undefined };
    }
    const obj = current as Record<string, unknown>;
    if (!(segment in obj)) {
      return { found: false, value: undefined };
    }
    current = obj[segment];
  }
  return { found: true, value: current };
}

/** Sets a dot-path value, creating intermediate objects, preserving siblings. */
function setOwnedValue(root: Record<string, unknown>, mergeKey: string, value: unknown): void {
  const segments = mergeKey.split('.');
  let cursor = root;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    const next = cursor[seg];
    if (next === null || typeof next !== 'object' || Array.isArray(next)) {
      cursor[seg] = {};
    }
    cursor = cursor[seg] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]!] = value;
}

/** Order-insensitive structural deep-equality for JSON values. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  return aKeys.every((key) => key in bObj && deepEqual(aObj[key], bObj[key]));
}

/** A planned write computed before any disk mutation (UN3 fails on the plan). */
interface PlannedWrite {
  path: string;
  providerId: ProviderId;
  /** The exact bytes to write (post-merge for merge-key files). */
  content: string;
  reason: FileApply['reason'];
  mergeKey?: string;
  /**
   * 'overwrite'/'headerless' fully own the path → a second overwrite emit at
   * the same path is the UN3 conflict. 'merge-key' files can legitimately
   * stack (different owned keys in one settings.json), so they never conflict.
   */
  emitKind: 'fully-owned' | 'merge-key';
}

type PlanEntry =
  | { kind: 'skip'; file: FileApply }
  | { kind: 'block'; file: FileApply }
  | { kind: 'write'; file: FileApply; write: PlannedWrite };

/**
 * Decides a header-bearing overwrite file's fate. `clean` → skip; `missing`,
 * `stale`, and `unmanaged` overwrite freely; `edited` defers to the prompt.
 */
function planHeaderBearing(
  file: EmittedFile,
  providerId: ProviderId,
  writer: FileWriter,
): { reason: FileApply['reason']; needsPrompt: boolean; skip: boolean } {
  const disk = writer.read(file.path);
  if (disk === null) {
    return { reason: 'missing', needsPrompt: false, skip: false };
  }
  const status = verifyAgainstExpected(disk, file.body).status;
  switch (status) {
    case 'clean':
      return { reason: 'clean', needsPrompt: false, skip: true };
    case 'stale':
      return { reason: 'stale', needsPrompt: false, skip: false };
    case 'unmanaged':
      // An owned path holding a headerless foreign file. `apply` owns these
      // paths (PRD §10), so it overwrites; the interactive reconciliation of
      // pre-existing foreign content is init's job (C3, out of scope here).
      return { reason: 'unmanaged', needsPrompt: false, skip: false };
    case 'edited':
      return { reason: 'edited', needsPrompt: true, skip: false };
  }
}

/**
 * Decides a headerless owned file's fate via the state-file three-way
 * (clean/stale/edited) plus the missing case.
 */
function planHeaderless(
  file: EmittedFile,
  writer: FileWriter,
  state: ApplyState,
): { reason: FileApply['reason']; needsPrompt: boolean; skip: boolean } {
  const disk = writer.read(file.path);
  if (disk === null) {
    return { reason: 'missing', needsPrompt: false, skip: false };
  }
  const verdict = classifyHeaderless(disk, file.body, state.emitted[file.path]);
  switch (verdict) {
    case 'clean':
      return { reason: 'clean', needsPrompt: false, skip: true };
    case 'stale':
      return { reason: 'stale', needsPrompt: false, skip: false };
    case 'edited':
      return { reason: 'edited', needsPrompt: true, skip: false };
  }
}

/**
 * Parses a merge-key target's current disk content into a JSON object root,
 * or `{}` when the file is absent/empty. Throws `MalformedProviderConfigError`
 * (exit 3, UN2) when the existing file is not a parseable JSON object — the
 * tool refuses to merge into a file it cannot safely round-trip.
 */
function readMergeRoot(path: string, disk: string | null): Record<string, unknown> {
  if (disk === null || disk.trim() === '') {
    return {};
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(disk);
  } catch (err) {
    throw new MalformedProviderConfigError(
      path,
      `cannot merge owned key(s) into invalid JSON: ` +
        (err instanceof Error ? err.message : String(err)),
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new MalformedProviderConfigError(
      path,
      `cannot merge: top-level value of ${path} is not a JSON object`,
    );
  }
  return parsed as Record<string, unknown>;
}

/** True when the owned key at `mergeKey` already deep-equals the projection. */
function ownedKeyMatches(
  root: Record<string, unknown>,
  mergeKey: string,
  expected: unknown,
): boolean {
  const { found, value } = resolveOwnedValue(root, mergeKey);
  return found && deepEqual(value, expected);
}

export async function apply(deps: ApplyDeps): Promise<ApplyReport> {
  const { flags } = deps;

  // STATE1: refuse on a dirty tree unless --allow-dirty. Exit 1 (a refusal to
  // act, not a config error — distinct from the parse/config exit 3 below).
  // Checked before parsing so a dirty repo fails fast and writes nothing.
  if (!flags.allowDirty && (await deps.isDirty())) {
    return {
      files: [],
      warnings: [],
      written: [],
      skipped: [],
      blocked: [],
      nothingToDo: true,
      dryRun: flags.dryRun,
      exitCode: 1,
      refused: 'dirty-tree',
    };
  }

  // Parse + config errors throw DomainError (exit 3) — surfaced by layer 4.
  const { ir, warnings: parseWarnings } = await deps.parse();
  const warnings: Warning[] = [...parseWarnings];

  // Project through every enabled adapter. A malformed co-owned provider file
  // can throw MalformedProviderConfigError here (exit 3) during projection.
  const emits: { file: EmittedFile; providerId: ProviderId }[] = [];
  for (const adapter of deps.adapters) {
    const projection = adapter.project(ir, deps.contextFor(adapter.id));
    warnings.push(...projection.warnings);
    for (const file of projection.files) {
      emits.push({ file, providerId: adapter.id });
    }
  }

  // UN3: two `overwrite` (fully-owned) emits targeting the same path conflict.
  // Detected across all adapters BEFORE any write so neither can clobber the
  // other. Merge-key emits may legitimately share a path (different keys).
  const ownedBy = new Map<string, ProviderId>();
  for (const { file, providerId } of emits) {
    if (file.mode !== 'overwrite') {
      continue;
    }
    const prior = ownedBy.get(file.path);
    if (prior !== undefined) {
      // Reuse EmitPathCollisionError (exit 3): "two sources project to the
      // same file". Naming both adapters in the message; exit 3 is its
      // domain code. (See DEVIATIONS — UN3 says "fail before any write"; we
      // pick the existing collision error's exit 3.)
      throw new EmitPathCollisionError(file.path, prior, providerId);
    }
    ownedBy.set(file.path, providerId);
  }

  const state = deps.readState();

  // Build a complete plan (skip/write/block) WITHOUT writing — UN2 (malformed
  // merge target) throws here, before any mutation; --dry-run stops after this.
  const plan: PlanEntry[] = [];

  // Merge-key emits are grouped by their (shared) target path: a provider can
  // own SEVERAL keys in one file (Gemini owns both `hooks` and
  // `context.fileName` in `.gemini/settings.json`). All owned keys for a path
  // must be applied onto a SINGLE root read once from disk, then written once
  // — planning each key against the original disk and writing sequentially
  // would let the last write clobber the others' keys (and break idempotency).
  const mergeByPath = new Map<string, { file: EmittedFile; providerId: ProviderId }[]>();
  for (const emit of emits) {
    if (emit.file.mode === 'merge-key') {
      const group = mergeByPath.get(emit.file.path);
      if (group === undefined) {
        mergeByPath.set(emit.file.path, [emit]);
      } else {
        group.push(emit);
      }
    }
  }

  for (const [path, group] of mergeByPath) {
    const disk = deps.writer.read(path);
    const root = readMergeRoot(path, disk); // UN2: throws exit 3 on malformed
    let changed = false;
    // One report entry per owned key; the path is written at most once.
    for (const { file, providerId } of group) {
      const mergeKey = file.mergeKey ?? '';
      const expected = JSON.parse(file.body) as unknown;
      if (ownedKeyMatches(root, mergeKey, expected) && disk !== null && disk.trim() !== '') {
        plan.push({ kind: 'skip', file: fileApply(file, providerId, 'skipped', 'clean') });
        continue;
      }
      setOwnedValue(root, mergeKey, expected);
      changed = true;
      plan.push({
        kind: 'write',
        file: fileApply(file, providerId, 'written', 'merge-changed'),
        write: {
          path,
          providerId,
          // The content is the SAME merged root for every key in the group;
          // de-duplicated to a single write below via `emitKind: 'merge-key'`.
          content: '',
          reason: 'merge-changed',
          ...(file.mergeKey !== undefined ? { mergeKey: file.mergeKey } : {}),
          emitKind: 'merge-key',
        },
      });
    }
    if (changed) {
      const mergedContent = `${JSON.stringify(root, null, 2)}\n`;
      for (const entry of plan) {
        if (entry.kind === 'write' && entry.write.emitKind === 'merge-key' && entry.write.path === path) {
          entry.write.content = mergedContent;
        }
      }
    }
  }

  for (const { file, providerId } of emits) {
    if (file.mode === 'merge-key') {
      continue; // handled above
    }
    const headered = detectHeaderPlacement(file.body) !== 'none';
    const decision = headered
      ? planHeaderBearing(file, providerId, deps.writer)
      : planHeaderless(file, deps.writer, state);

    if (decision.skip) {
      plan.push({ kind: 'skip', file: fileApply(file, providerId, 'skipped', decision.reason) });
      continue;
    }
    if (decision.needsPrompt) {
      // `edited`: prompt unless --non-interactive (UN1). The prompt is awaited
      // only while planning; no write has happened yet. A dry run never
      // prompts — a preview reports edited files as blocked without asking.
      const confirmed =
        flags.dryRun || flags.nonInteractive ? false : await deps.confirm(file.path);
      if (!confirmed) {
        plan.push({ kind: 'block', file: fileApply(file, providerId, 'blocked', 'edited') });
        continue;
      }
      plan.push({
        kind: 'write',
        file: fileApply(file, providerId, 'written', 'edited'),
        write: {
          path: file.path,
          providerId,
          content: file.body,
          reason: 'edited',
          emitKind: 'fully-owned',
        },
      });
      continue;
    }
    plan.push({
      kind: 'write',
      file: fileApply(file, providerId, 'written', decision.reason),
      write: {
        path: file.path,
        providerId,
        content: file.body,
        reason: decision.reason,
        emitKind: 'fully-owned',
      },
    });
  }

  const files = plan.map((entry) => entry.file);
  const planned = plan.filter((e): e is Extract<PlanEntry, { kind: 'write' }> => e.kind === 'write');
  const blocked = plan.filter((e) => e.kind === 'block').map((e) => e.file.path);
  const skipped = plan.filter((e) => e.kind === 'skip').map((e) => e.file.path);
  // De-duplicate writes by path: a grouped merge-key path produces one write
  // entry per owned key, but only ONE physical write of the fully merged
  // content. Keep the last content seen for a path (all merge-key entries for
  // a path carry the same final merged content).
  const writesByPath = new Map<string, string>();
  for (const entry of planned) {
    writesByPath.set(entry.write.path, entry.write.content);
  }
  const written = [...writesByPath.keys()];
  const nothingToDo = written.length === 0;

  // OPT1: dry run computes the full plan + report and returns without writing
  // anything (and without touching the state file). A preview always exits 0 —
  // it is a plan, not an action; edited files surface as blocked-in-preview.
  if (flags.dryRun) {
    return {
      files,
      warnings,
      written,
      skipped,
      blocked,
      nothingToDo,
      dryRun: true,
      exitCode: 0,
    };
  }

  // Real run: write each unique target path once (merge-key groups collapse to
  // a single physical write of the fully merged content), then persist the
  // state file recording the hash of every fully-owned emitted path.
  for (const [path, content] of writesByPath) {
    deps.writer.write(path, content);
  }

  // Record state for every fully-owned emit (the headerless three-way only
  // applies to fully-owned files; merge-key files are governed by JSON-key
  // comparison, never the state hash). The recorded hash is the content now on
  // disk for that path. EXCEPTION: a BLOCKED edited file keeps the user's
  // content on disk — recording its hash would make a later apply treat that
  // very content as a prior emission ('stale') and overwrite it without
  // prompting. So a blocked path is left out, preserving its 'edited' verdict
  // until the user resolves it.
  const blockedPaths = new Set(blocked);
  const nextEmitted: Record<string, string> = { ...state.emitted };
  for (const { file } of emits) {
    if (file.mode !== 'overwrite' || blockedPaths.has(file.path)) {
      continue;
    }
    const onDisk = deps.writer.read(file.path);
    if (onDisk !== null) {
      nextEmitted[file.path] = contentHash(onDisk);
    }
  }
  const nextState: ApplyState = { version: 1, emitted: nextEmitted };
  deps.writeState(nextState);

  // EV1: nothing to write → exit 0 (the caller prints "nothing to do").
  // A blocked edit under --non-interactive is the UN1 failure → exit 1.
  const exitCode: 0 | 1 | 3 = blocked.length > 0 && flags.nonInteractive ? 1 : 0;

  return {
    files,
    warnings,
    written,
    skipped,
    blocked,
    nothingToDo,
    dryRun: false,
    exitCode,
  };
}

function fileApply(
  file: EmittedFile,
  providerId: ProviderId,
  action: ApplyAction,
  reason: FileApply['reason'],
): FileApply {
  const entry: FileApply = { path: file.path, providerId, action, reason };
  if (file.mergeKey !== undefined) {
    entry.mergeKey = file.mergeKey;
  }
  return entry;
}
