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
 */
export function recoverFromShim(content: string): string {
  const newlineAt = content.indexOf('\n');
  const firstLine = (newlineAt === -1 ? content : content.slice(0, newlineAt)).trimEnd();
  if (firstLine === AGENTS_IMPORT_LINE) {
    return newlineAt === -1 ? '' : content.slice(newlineAt + 1);
  }
  return content;
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
