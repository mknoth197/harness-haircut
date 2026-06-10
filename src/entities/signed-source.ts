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
import { InvalidSourcePathError } from './errors.js';

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

function normalizeEol(content: string): string {
  return content.replace(/\r\n/g, '\n');
}

/**
 * Sorts entries by path and joins `<path>:<sha256>` with `\n` (F2 U3).
 * Throws `InvalidSourcePathError` if a path contains `\n` — such a path
 * would make the newline-joined manifest ambiguous.
 */
export function canonicalManifest(sources: SourceManifest): string {
  return [...sources]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))
    .map((entry) => {
      if (entry.path.includes('\n')) {
        throw new InvalidSourcePathError(entry.path);
      }
      return `${entry.path}:${entry.sha256}`;
    })
    .join('\n');
}

function bodyHash(body: string): string {
  // CRLF → LF before hashing: verification stays EOL-insensitive, so a
  // Windows autocrlf checkout does not produce false 'edited' results.
  return sha256Hex(normalizeEol(body)).slice(0, HASH_LEN);
}

function sourcesHash(sources: SourceManifest): string {
  return sha256Hex(canonicalManifest(sources)).slice(0, HASH_LEN);
}

/** A header recognized in a file, plus the content its BODY_HASH covers. */
interface ExtractedHeader {
  bodyHash: string;
  sourcesHash: string;
  /** The file minus the header line (frontmatter included for the after-frontmatter placement). */
  body: string;
}

/** Recognizes the header on the file's first line (PRD §9). */
function extractFirstLineHeader(file: string): ExtractedHeader | null {
  const newlineAt = file.indexOf('\n');
  const firstLine = newlineAt === -1 ? file : file.slice(0, newlineAt);
  const match = HEADER_RE.exec(firstLine);
  if (match === null) {
    return null;
  }
  return {
    bodyHash: match[1] ?? '',
    sourcesHash: match[2] ?? '',
    body: newlineAt === -1 ? '' : file.slice(newlineAt + 1),
  };
}

/**
 * Recognizes the header on the first line after the closing `---` of a
 * leading frontmatter block (PRD §9 "Header placement and carve-outs").
 */
function extractAfterFrontmatterHeader(file: string): ExtractedHeader | null {
  const end = frontmatterEnd(file);
  if (end === null || end >= file.length) {
    return null;
  }
  const rest = file.slice(end);
  const newlineAt = rest.indexOf('\n');
  const headerLine = newlineAt === -1 ? rest : rest.slice(0, newlineAt);
  const match = HEADER_RE.exec(headerLine);
  if (match === null) {
    return null;
  }
  return {
    bodyHash: match[1] ?? '',
    sourcesHash: match[2] ?? '',
    body: file.slice(0, end) + (newlineAt === -1 ? '' : rest.slice(newlineAt + 1)),
  };
}

/** Shared four-state verdict; `edited` wins over `stale` when both hashes mismatch. */
function verdict(extracted: ExtractedHeader | null, currentSources: SourceManifest): VerifyResult {
  if (extracted === null) {
    return { status: 'unmanaged' };
  }
  if (extracted.bodyHash !== bodyHash(extracted.body)) {
    return { status: 'edited' };
  }
  if (extracted.sourcesHash !== sourcesHash(currentSources)) {
    return { status: 'stale' };
  }
  return { status: 'clean' };
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
  return verdict(extractFirstLineHeader(file), currentSources);
}

/**
 * Returns the offset just past the closing `---` delimiter line (i.e. the
 * start of the first body line) of a leading frontmatter block, or `null`
 * when the content does not begin with a complete `---`-delimited block.
 */
function frontmatterEnd(content: string): number | null {
  const lines = content.split('\n');
  if ((lines[0] ?? '').trimEnd() !== '---') {
    return null;
  }
  let offset = (lines[0] ?? '').length + 1;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.trimEnd() === '---') {
      return Math.min(offset + line.length + 1, content.length);
    }
    offset += line.length + 1;
  }
  return null;
}

/**
 * Frontmatter-bearing variant of `embedHeader` (PRD §9 "Header placement and
 * carve-outs"): providers need YAML frontmatter on line 1 to parse
 * `paths:` / `applyTo:` / `name:`, so the header line cannot be first.
 * Instead it is inserted immediately after the closing `---`, and
 * `BODY_HASH` covers the **entire** content — frontmatter and body
 * (CRLF-normalized) — so an edit to a frontmatter glob line still verifies
 * as 'edited'. `content` MUST begin with a `---`-delimited frontmatter
 * block; adapters construct that block themselves, so a violation is an
 * internal bug.
 */
export function embedHeaderAfterFrontmatter(content: string, sources: SourceManifest): string {
  const end = frontmatterEnd(content);
  if (end === null) {
    throw new Error(
      'embedHeaderAfterFrontmatter requires content beginning with a "---"-delimited frontmatter block',
    );
  }
  const line = `${HEADER_TAG}<<<${bodyHash(content)}.${sourcesHash(sources)}>>> harness-haircut DO NOT EDIT`;
  const head = content.slice(0, end);
  const separator = head.endsWith('\n') ? '' : '\n';
  return `${head}${separator}${COMMENT_WRAPPERS.html(line)}\n${content.slice(end)}`;
}

/**
 * Counterpart verifier for `embedHeaderAfterFrontmatter`: recognizes the
 * header on the first line after the closing `---` of a leading frontmatter
 * block, strips that header line, and hashes the remainder (frontmatter +
 * body). Same four-state verdict as `verifyHeader`; `edited` wins over
 * `stale`.
 */
export function verifyHeaderAfterFrontmatter(
  file: string,
  currentSources: SourceManifest,
): VerifyResult {
  return verdict(extractAfterFrontmatterHeader(file), currentSources);
}

export type HeaderPlacement = 'first-line' | 'after-frontmatter' | 'none';

/**
 * Detects where a SignedSource header sits in `content`, distinguishing the
 * line-1 convention from the frontmatter-bearing convention (PRD §9 v0.3.1).
 * Audit derives the verification method for each emitted file from the
 * freshly projected body, so the §9 placement rules need no per-file
 * bookkeeping.
 */
export function detectHeaderPlacement(content: string): HeaderPlacement {
  if (extractFirstLineHeader(content) !== null) {
    return 'first-line';
  }
  if (extractAfterFrontmatterHeader(content) !== null) {
    return 'after-frontmatter';
  }
  return 'none';
}

/**
 * Audit-time verifier: compares a disk file against the expected emission
 * freshly projected from the current canonical sources. No source manifest
 * is needed — the expected emission already embeds the current
 * `SOURCES_HASH`, so EOL-normalized byte equality is equivalent to both
 * hashes matching:
 *
 * - disk ≡ expected (CRLF-insensitive)            → 'clean'
 * - no header at the expected placement on disk    → 'unmanaged'
 * - disk BODY_HASH ≠ hash of the disk body         → 'edited'
 * - header intact but file ≠ current projection    → 'stale'
 *
 * `expected` MUST carry a header (callers route headerless classes — shims,
 * merge-key targets, owned JSON, attachments — elsewhere per §9), so a
 * violation is an internal bug.
 */
export function verifyAgainstExpected(disk: string, expected: string): VerifyResult {
  const placement = detectHeaderPlacement(expected);
  if (placement === 'none') {
    throw new Error(
      'verifyAgainstExpected requires an expected emission carrying a SignedSource header',
    );
  }
  if (normalizeEol(disk) === normalizeEol(expected)) {
    return { status: 'clean' };
  }
  const extracted =
    placement === 'first-line'
      ? extractFirstLineHeader(disk)
      : extractAfterFrontmatterHeader(disk);
  if (extracted === null) {
    return { status: 'unmanaged' };
  }
  if (extracted.bodyHash !== bodyHash(extracted.body)) {
    return { status: 'edited' };
  }
  return { status: 'stale' };
}
