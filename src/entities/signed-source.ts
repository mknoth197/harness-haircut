/**
 * SignedSource header generator and verifier — F2 (#5), PRD §9.
 *
 * Two separate hashes are required: a single combined hash cannot
 * distinguish 'edited' (user touched the emitted body) from 'stale'
 * (canonical sources changed since emit) at verify time.
 *
 * `node:crypto.createHash` is deterministic and I/O-free, so it is allowed
 * in the entities layer (story F2 acceptance criteria).
 *
 * PRD §9 carve-outs (one-line import shims, merge-key JSON targets) take no
 * header and are governed elsewhere, not by this module.
 */
import { createHash } from 'node:crypto';

export const HEADER_TAG = '@generated SignedSource';
export const HASH_LEN = 16;

export type CommentSyntax = 'html' | 'hash' | 'slash';

export interface SourceEntry {
  /** Repo-relative canonical path. */
  path: string;
  /** Full lowercase-hex SHA-256 of the source file's content. */
  sha256: string;
}

export type SourceManifest = readonly SourceEntry[];

export type VerifyStatus = 'clean' | 'edited' | 'stale' | 'unmanaged';

export interface VerifyResult {
  status: VerifyStatus;
}

const COMMENT_WRAPPERS: Readonly<Record<CommentSyntax, (line: string) => string>> = {
  html: (line) => `<!-- ${line} -->`,
  hash: (line) => `# ${line}`,
  slash: (line) => `// ${line}`,
};

const HEADER_RE = new RegExp(
  `${HEADER_TAG}<<<([0-9a-f]{${HASH_LEN}})\\.([0-9a-f]{${HASH_LEN}})>>>`,
);

function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/** Sorts entries by path and joins `<path>:<sha256>` with `\n` (F2 U3). */
export function canonicalManifest(sources: SourceManifest): string {
  return [...sources]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((entry) => `${entry.path}:${entry.sha256}`)
    .join('\n');
}

function bodyHash(body: string): string {
  return sha256Hex(body).slice(0, HASH_LEN);
}

function sourcesHash(sources: SourceManifest): string {
  return sha256Hex(canonicalManifest(sources)).slice(0, HASH_LEN);
}

/**
 * Prefixes `body` with the SignedSource header line wrapped in the given
 * comment syntax. `BODY_HASH` binds everything after the header line.
 */
export function embedHeader(
  body: string,
  sources: SourceManifest,
  syntax: CommentSyntax,
): string {
  const line = `${HEADER_TAG}<<<${bodyHash(body)}.${sourcesHash(sources)}>>> harness-haircut DO NOT EDIT`;
  return `${COMMENT_WRAPPERS[syntax](line)}\n${body}`;
}

/**
 * Verifies a disk file against the current canonical sources. The header is
 * only recognized on the file's first line (PRD §9). `edited` wins over
 * `stale` when both hashes mismatch.
 */
export function verifyHeader(file: string, currentSources: SourceManifest): VerifyResult {
  const newlineAt = file.indexOf('\n');
  const firstLine = newlineAt === -1 ? file : file.slice(0, newlineAt);
  const match = HEADER_RE.exec(firstLine);
  if (match === null) {
    return { status: 'unmanaged' };
  }
  const body = newlineAt === -1 ? '' : file.slice(newlineAt + 1);
  if (match[1] !== bodyHash(body)) {
    return { status: 'edited' };
  }
  if (match[2] !== sourcesHash(currentSources)) {
    return { status: 'stale' };
  }
  return { status: 'clean' };
}
