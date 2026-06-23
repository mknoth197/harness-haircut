/**
 * Pure helpers for recovering candidate canonical text from existing provider
 * instruction files — C3 (#13), layer 1 (entities). No I/O: callers (the
 * `init` use case) read the bytes through an injected reader and hand them in.
 *
 * Each provider stores "root instruction" content differently, and most wrap
 * the real text in a header the canonical `AGENTS.md` must not carry:
 *
 *   - `AGENTS.md`                         → verbatim (already canonical shape)
 *   - `CLAUDE.md` / `GEMINI.md`           → strip a leading `@AGENTS.md` import
 *                                           line if present (the shim carve-out)
 *   - `.github/copilot-instructions.md`   → strip a leading SignedSource header
 *                                           line and the code-review HTML note
 *
 * `normalizeForCompare` is applied only when deciding whether two candidates
 * AGREE (EV1) — the recovered original text is what gets written.
 */
import { AGENTS_IMPORT_LINE } from './ir.js';

/** The HTML comment the Copilot adapter prepends to `.github/copilot-instructions.md`. */
const COPILOT_REVIEW_NOTE_RE =
  /^<!--\s*This file exists for Copilot code review[\s\S]*?-->\n?/;

/** A SignedSource header line (any comment syntax) at the very start of a file. */
const SIGNED_SOURCE_LINE_RE = /^.*@generated SignedSource<<<[0-9a-f.]+>>>.*\n?/;

/**
 * Trailing-whitespace-insensitive, trailing-newline-insensitive comparison
 * key. Each line is right-trimmed and the whole text collapsed to a single
 * (absent) final newline, so cosmetically-different copies of the same content
 * compare equal (EV1) without a real content difference being masked.
 */
export function normalizeForCompare(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(/\s+$/, ''))
    .join('\n')
    .replace(/\n+$/, '');
}

/** Root `AGENTS.md` is already canonical shape — its text is taken verbatim. */
export function recoverFromAgentsMd(content: string): string {
  return content;
}

/**
 * Strips a leading `@AGENTS.md` import line from a `CLAUDE.md` / `GEMINI.md`
 * shim, returning the user content below it. When the file is not a shim (no
 * leading import) the whole content is returned — it is genuine instruction
 * text the user kept in that file.
 *
 * Multi-import carve-out: a root `CLAUDE.md` may follow `@AGENTS.md` with
 * several more `@…/instructions/*.md` import lines — a valid Claude Code
 * pattern, and the very layout harness-haircut promotes. Those `@`-import lines
 * are mere POINTERS to instruction files already captured separately as scoped
 * fragments; they are NOT original prose. So once the leading `@AGENTS.md` is
 * stripped, if EVERY remaining non-blank line is itself an `@`-import line the
 * file is a PURE shim and contributes no instruction content — we recover `''`
 * (treated by the caller as "no candidate", so it cannot manufacture a spurious
 * root-instructions contradiction). A file that mixes imports with genuine
 * prose keeps that prose verbatim (the imports ride along — they round-trip as
 * harmless text rather than risking silent loss of the prose around them).
 */
export function recoverFromShim(content: string): string {
  // Strip a leading UTF-8 BOM before the first-line check — mirror the shim
  // WRITER (adapters/shim.ts). An editor adds it invisibly, and without this a
  // BOM-saved shim's first line is `<BOM>@AGENTS.md` !== `@AGENTS.md`, so the
  // whole file (import lines and all) would be returned as content and
  // re-manufacture the spurious root-instructions contradiction this fixes.
  const stripped = content.startsWith('\uFEFF') ? content.slice(1) : content;
  const newlineAt = stripped.indexOf('\n');
  const firstLine = (newlineAt === -1 ? stripped : stripped.slice(0, newlineAt)).trimEnd();
  if (firstLine !== AGENTS_IMPORT_LINE) {
    return stripped;
  }
  const rest = newlineAt === -1 ? '' : stripped.slice(newlineAt + 1);
  if (isPureImportBlock(rest)) {
    return '';
  }
  return rest;
}

/**
 * Matches a real `@`-import line: `@` followed by a path-like token with NO
 * embedded whitespace, ending in `.md`. The real imports are `@AGENTS.md`,
 * `@.github/instructions/foo.instructions.md`, and relative forms like
 * `@../../.github/instructions/ui.instructions.md` — all of which match.
 *
 * Crucially this EXCLUDES prose that merely begins with `@`: `@TODO rewrite`
 * (embedded space), `@channel ping the team` (no `.md`), a JSDoc `@param x`
 * (space), a CSS `@media screen` (space), an at-mention `@alice` (no `.md`).
 * The previous `startsWith('@')` test treated all of those as droppable
 * imports, so a CLAUDE.md mixing such prose with `@AGENTS.md` collapsed to `''`
 * and the prose was silently lost — the data-loss bug this regex fixes.
 */
const IMPORT_LINE_RE = /^@\S+\.md$/;

/**
 * True when every non-blank line is a real `@`-import line (see
 * `IMPORT_LINE_RE`). An all-blank/empty string qualifies — a single-line
 * `@AGENTS.md` shim recovers `''` exactly as before. Any non-blank line that is
 * NOT an import (i.e. genuine prose, even prose that starts with `@`) means the
 * block is NOT a pure import shim and its content must be kept verbatim.
 */
function isPureImportBlock(text: string): boolean {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .every((line) => IMPORT_LINE_RE.test(line));
}

/**
 * Finding #3 (F2 "no silent loss") classifier for the `init` use case: true
 * when `content` is a PURE multi-import `CLAUDE.md`/`GEMINI.md` shim that
 * `recoverFromShim` collapses to `''` AND more than the bare `@AGENTS.md` line
 * was collapsed (i.e. at least one additional `@…/….md` import line rode along).
 *
 * The caller uses this to emit a user-visible note WHEN it drops such a shim, so
 * the action is never silent. It deliberately returns `false` for the trivial
 * single-line `@AGENTS.md` shim (and an emptied file): that is the expected,
 * noiseless case and warrants no note. Returns `false` for anything
 * `recoverFromShim` would keep (a non-shim, or a shim with genuine prose).
 */
export function isMultiImportShim(content: string): boolean {
  const stripped = content.startsWith('\uFEFF') ? content.slice(1) : content;
  const newlineAt = stripped.indexOf('\n');
  const firstLine = (newlineAt === -1 ? stripped : stripped.slice(0, newlineAt)).trimEnd();
  if (firstLine !== AGENTS_IMPORT_LINE) {
    return false;
  }
  const rest = newlineAt === -1 ? '' : stripped.slice(newlineAt + 1);
  if (!isPureImportBlock(rest)) {
    return false;
  }
  // Pure shim: a note is warranted only when an import line beyond `@AGENTS.md`
  // was collapsed. The bare single-line shim leaves `rest` all-blank.
  return rest.split('\n').some((line) => line.trim() !== '');
}

/**
 * Strips a leading SignedSource header line (if present) and the code-review
 * HTML note the Copilot adapter emits, returning the instruction body.
 */
export function recoverFromCopilotInstructions(content: string): string {
  let body = content.replace(SIGNED_SOURCE_LINE_RE, '');
  // The adapter emits "<note>\n\n<body>"; drop a leading blank line left after
  // the header line was removed, then the note, then its trailing blank lines.
  body = body.replace(/^\n+/, '');
  body = body.replace(COPILOT_REVIEW_NOTE_RE, '');
  body = body.replace(/^\n+/, '');
  return body;
}

/**
 * A recovered scoped instruction fragment — C3 F1. `scope` is a single glob
 * string (the canonical `.agents/instructions/<name>.md` shape uses one
 * `scope:` per fragment); when a provider file lists several globs they are
 * comma-joined into one canonical scope. `body` is the instruction text below
 * the frontmatter (and below any emitted SignedSource header), ready to write
 * verbatim under a fresh `scope:` frontmatter.
 */
export interface RecoveredFragment {
  /** Comma-joined glob(s) for the canonical `scope:` key. */
  scope: string;
  /** Instruction body below the frontmatter / header. */
  body: string;
}

/** Recognizes a leading `---`-delimited frontmatter block; returns its inner lines + body. */
interface SplitFrontmatter {
  /** Raw lines between the opening and closing `---` (frontmatter omitted when null). */
  fmLines: string[] | null;
  /** Everything after the closing `---` (or the whole content when no frontmatter). */
  body: string;
}

/**
 * Splits a leading `---`-delimited frontmatter block from the body. Returns
 * `fmLines: null` when the content does not begin with a complete block (a
 * lone leading `---` with no closing fence is treated as no frontmatter).
 */
function splitLeadingFrontmatter(content: string): SplitFrontmatter {
  const lines = content.split('\n');
  if ((lines[0] ?? '').trimEnd() !== '---') {
    return { fmLines: null, body: content };
  }
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? '').trimEnd() === '---') {
      return { fmLines: lines.slice(1, i), body: lines.slice(i + 1).join('\n') };
    }
  }
  return { fmLines: null, body: content };
}

/**
 * Strips a leading SignedSource header line from a recovered fragment body.
 * Provider fragments emitted by `apply` carry the header on the FIRST line of
 * the body (after the frontmatter); a hand-written drifted fragment carries
 * none. Either way the body below the header is what we recover.
 */
function stripFragmentHeader(body: string): string {
  if (SIGNED_SOURCE_LINE_RE.test(body)) {
    return body.replace(SIGNED_SOURCE_LINE_RE, '');
  }
  return body;
}

/**
 * Recovers a scoped fragment from a Copilot `*.instructions.md` file: parses
 * the `applyTo:` frontmatter (a single comma-separated glob string) into the
 * canonical `scope`, then strips an optional SignedSource header from the body.
 * Returns `null` when there is no `applyTo:` frontmatter to derive a scope from
 * (the caller surfaces such a file as an un-recoverable note rather than
 * dropping it silently).
 */
export function recoverFragmentFromCopilot(content: string): RecoveredFragment | null {
  const { fmLines, body } = splitLeadingFrontmatter(content);
  if (fmLines === null) {
    return null;
  }
  const scope = parseApplyTo(fmLines);
  if (scope === null) {
    return null;
  }
  return { scope, body: stripFragmentHeader(body) };
}

/**
 * Recovers a scoped fragment from a Claude `.claude/rules/*.md` file: parses
 * the `paths:` frontmatter (a YAML list OR an inline `[...]` array) into the
 * canonical `scope`, then strips an optional SignedSource header from the body.
 * Returns `null` when there is no `paths:` frontmatter (surfaced as a note).
 */
export function recoverFragmentFromClaudeRule(content: string): RecoveredFragment | null {
  const { fmLines, body } = splitLeadingFrontmatter(content);
  if (fmLines === null) {
    return null;
  }
  const scope = parsePaths(fmLines);
  if (scope === null) {
    return null;
  }
  return { scope, body: stripFragmentHeader(body) };
}

/**
 * C6 (#44) — recovers a scoped fragment from an EXISTING canonical
 * `.agents/instructions/<name>.md` file: parses its own `scope:` frontmatter
 * (the shape `init`/`apply` write — `fragmentCanonicalText`). Used only under
 * `--adopt`, where a hand-built canonical fragment is the highest-precedence
 * candidate for its slot, so a same-named provider fragment becomes a proper
 * contradiction (EV2/EV3) instead of silently overwriting it. Returns `null`
 * when there is no `scope:` frontmatter (surfaced as a note, never dropped).
 */
export function recoverFragmentFromCanonical(content: string): RecoveredFragment | null {
  const { fmLines, body } = splitLeadingFrontmatter(content);
  if (fmLines === null) {
    return null;
  }
  const scope = parseScope(fmLines);
  if (scope === null) {
    return null;
  }
  return { scope, body: stripFragmentHeader(body) };
}

/**
 * Parses a frontmatter glob-list value for `key` into a comma-joined scope,
 * accepting all three YAML shapes a hand-author might use: a scalar
 * (`key: "<glob>"` quoted, or `key: <glob>,<glob>` comma-joined), an inline
 * array (`key: ["a", "b"]`), or a block sequence (`key:` then `- a` lines).
 * Returns `null` when `key` is absent or carries no globs. Shared by the
 * canonical `scope:` and Claude-rule `paths:` readers so a hand-written array
 * scope is normalized rather than captured as a literal string (which would
 * broaden the rule to match every file).
 */
function parseGlobList(fmLines: string[], key: string): string | null {
  const prefix = `${key}:`;
  for (let i = 0; i < fmLines.length; i++) {
    const raw = (fmLines[i] ?? '').trim();
    if (!raw.startsWith(prefix)) {
      continue;
    }
    const rest = raw.slice(prefix.length).trim();
    if (rest.startsWith('[') && rest.endsWith(']')) {
      const inner = rest.slice(1, -1).trim();
      const globs =
        inner === ''
          ? []
          : inner.split(',').map((g) => unquoteScalar(g.trim())).filter((g) => g !== '');
      return globs.length === 0 ? null : globs.join(',');
    }
    if (rest !== '') {
      // `key: <glob>` scalar form (already comma-joined for a multi-glob scope).
      const scalar = unquoteScalar(rest);
      return scalar === '' ? null : scalar;
    }
    // Block sequence: collect following `- item` lines.
    const globs: string[] = [];
    for (let j = i + 1; j < fmLines.length; j++) {
      const item = /^-\s+(.+)$/.exec((fmLines[j] ?? '').trim());
      if (item === null) {
        break;
      }
      const glob = unquoteScalar((item[1] ?? '').trim());
      if (glob !== '') {
        globs.push(glob);
      }
    }
    return globs.length === 0 ? null : globs.join(',');
  }
  return null;
}

/** Reads the canonical `scope:` frontmatter (scalar / inline-array / block-sequence). */
function parseScope(fmLines: string[]): string | null {
  return parseGlobList(fmLines, 'scope');
}

/** Reads a single-line `applyTo: "<glob>,<glob>"` (or unquoted) into a comma-joined scope. */
function parseApplyTo(fmLines: string[]): string | null {
  for (const raw of fmLines) {
    const match = /^applyTo:\s*(.*)$/.exec(raw.trim());
    if (match === null) {
      continue;
    }
    const value = unquoteScalar((match[1] ?? '').trim());
    const globs = value
      .split(',')
      .map((g) => g.trim())
      .filter((g) => g !== '');
    return globs.length === 0 ? null : globs.join(',');
  }
  return null;
}

/**
 * Reads `paths:` from Claude-rule frontmatter — a scalar, an inline
 * `paths: ["a", "b"]` array, or a block sequence of `- a` lines — into a
 * comma-joined scope. Returns `null` when no `paths:` key is present.
 */
function parsePaths(fmLines: string[]): string | null {
  return parseGlobList(fmLines, 'paths');
}

/** Strips matching single/double quotes from a scalar (no escape processing). */
function unquoteScalar(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/**
 * Derives the canonical fragment name from a provider source filename: strips
 * the directory, the harness-emitted `hh.` prefix if present, and the
 * `.instructions.md` / `.md` suffix. `.github/instructions/hh.security.instructions.md`
 * → `security`; `.claude/rules/testing.md` → `testing`.
 */
export function fragmentNameFromSource(path: string): string {
  let base = path.slice(path.lastIndexOf('/') + 1);
  if (base.startsWith('hh.')) {
    base = base.slice('hh.'.length);
  }
  if (base.endsWith('.instructions.md')) {
    return base.slice(0, -'.instructions.md'.length);
  }
  if (base.endsWith('.md')) {
    return base.slice(0, -'.md'.length);
  }
  return base;
}
