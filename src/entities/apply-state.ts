/**
 * Apply state file — C2 (#12), PRD §9 carve-out 2 + the C2 design note.
 *
 * Headerless fully-owned JSON files (`.codex/hooks.json`,
 * `.github/hooks/*.json`) and verbatim skill attachments carry no
 * SignedSource header (JSON has no comments; a header would corrupt a
 * shebang/asset). Full-content comparison alone collapses `edited` (the user
 * touched the file) and `stale` (canonical sources changed since the last
 * emit) into one indistinguishable "differs" state — which `audit` correctly
 * reports as drift, but which `apply` must split apart to decide whether to
 * overwrite freely (stale) or prompt first (edited).
 *
 * The state file restores the distinction by recording, after every
 * successful `apply`, the sha256 of the content harness-haircut last wrote to
 * each emitted path. The three-way decision is then:
 *
 *   disk === current projection          → clean   (skip)
 *   disk === recorded prior emission      → stale   (overwrite freely)
 *   otherwise                             → edited  (prompt / --non-interactive fail)
 *
 * First run (no recorded entry) with a differing disk file is conservatively
 * `edited` — we have never written this path, so any existing different
 * content is the user's.
 *
 * `createHash` is deterministic and I/O-free, so it is allowed in entities
 * (matching `signed-source.ts`). The file LOCATION and the read/write I/O
 * live in the gateway / use case; this module is the pure format + decision.
 *
 * This file is meant to be COMMITTED, not gitignored: it is the team's shared
 * baseline of "what harness-haircut last emitted", so every clone agrees on
 * which on-disk changes are stale (safe to overwrite) versus hand-edited
 * (prompt). A consequence is that a successful `apply` leaves the tree dirty
 * (this file + the rewritten provider files) — that is the dirty-tree guard
 * (STATE1) working as intended; commit the apply output, then the tree is
 * clean again. `--allow-dirty` is the escape hatch for re-running before a
 * commit.
 */
import { createHash } from 'node:crypto';

/** Repo-relative POSIX location of the state file (gateway-agnostic). */
export const APPLY_STATE_PATH = '.agents/.harness-state.json';

/** On-disk shape: a version tag plus emitted-path → full sha256-hex map. */
export interface ApplyState {
  version: 1;
  /** emitted repo-relative path → sha256-hex of the last content we wrote. */
  emitted: Record<string, string>;
}

/** Full lowercase-hex SHA-256 of the EOL-normalized content. */
export function contentHash(content: string): string {
  return createHash('sha256').update(content.replace(/\r\n/g, '\n'), 'utf8').digest('hex');
}

/** A fresh, empty state (used when the file is absent or unparseable). */
export function emptyState(): ApplyState {
  return { version: 1, emitted: {} };
}

/**
 * Parses the state file's text into an `ApplyState`. A missing file (`null`),
 * malformed JSON, or an unexpected shape all degrade to an empty state rather
 * than throwing: the state file is an internal optimization, and a corrupt
 * one must never block `apply` or be confused with a malformed *user* config.
 * The conservative consequence of an empty state is that headerless files
 * differing from disk are treated as `edited` (prompted), which is safe.
 */
export function parseState(raw: string | null): ApplyState {
  if (raw === null) {
    return emptyState();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return emptyState();
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return emptyState();
  }
  const emitted = (parsed as Record<string, unknown>)['emitted'];
  if (emitted === null || typeof emitted !== 'object' || Array.isArray(emitted)) {
    return emptyState();
  }
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(emitted as Record<string, unknown>)) {
    if (typeof value === 'string') {
      out[key] = value;
    }
  }
  return { version: 1, emitted: out };
}

/** Serializes an `ApplyState` deterministically (sorted keys, trailing NL). */
export function serializeState(state: ApplyState): string {
  const sortedEmitted: Record<string, string> = {};
  for (const key of Object.keys(state.emitted).sort()) {
    sortedEmitted[key] = state.emitted[key]!;
  }
  return `${JSON.stringify({ version: state.version, emitted: sortedEmitted }, null, 2)}\n`;
}

export type HeaderlessVerdict = 'clean' | 'stale' | 'edited';

/**
 * Three-way decision for a headerless owned file (C2 design note). `disk` is
 * the current on-disk content (must exist — a missing file is `missing`,
 * handled by the caller, not here); `projection` is the freshly emitted body;
 * `recordedHash` is the state file's entry for this path, or `undefined` when
 * the path was never recorded. EOL-insensitive throughout.
 */
export function classifyHeaderless(
  disk: string,
  projection: string,
  recordedHash: string | undefined,
): HeaderlessVerdict {
  if (disk.replace(/\r\n/g, '\n') === projection.replace(/\r\n/g, '\n')) {
    return 'clean';
  }
  if (recordedHash !== undefined && contentHash(disk) === recordedHash) {
    return 'stale';
  }
  return 'edited';
}
