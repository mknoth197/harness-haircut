/**
 * One-line `@AGENTS.md` import-shim projection, shared by the Claude
 * adapter (`CLAUDE.md`, A2) and the Gemini adapter in shim mode
 * (`GEMINI.md`, A3).
 *
 * Shims carry no SignedSource header (PRD §9 carve-out 1): the first line
 * MUST be the import for the provider to resolve it, and the content
 * references — never derives from — canonical sources. The tool owns only
 * the first line; everything below is user content:
 *
 * - no existing file        → emit the one-line shim ('emitted')
 * - first line is the import → emit nothing, user content below is
 *                              preserved by never rewriting ('merged')
 * - anything else           → leave untouched + HH-W005 ('skipped'); the
 *                             file is a conflicting instruction source that
 *                             `init` (C3) resolves interactively
 */
import type { EmittedFile, ProviderFileReader } from '../entities/adapter.js';
import type { Warning } from '../entities/warnings.js';

export const SHIM_IMPORT_LINE = '@AGENTS.md';
export const SHIM_BODY = `${SHIM_IMPORT_LINE}\n`;

export interface ShimProjection {
  file: EmittedFile | null;
  warning: Warning | null;
  status: 'emitted' | 'merged' | 'skipped';
}

export function projectImportShim(
  path: string,
  reader: ProviderFileReader | undefined,
  providerId: string,
): ShimProjection {
  const raw = reader?.read(path) ?? null;
  // An empty or whitespace-only file carries no user content to preserve and
  // no conflicting instructions — treat it as absent and emit the shim.
  if (raw === null || raw.trim() === '') {
    return {
      file: { path, body: SHIM_BODY, mode: 'overwrite' },
      warning: null,
      status: 'emitted',
    };
  }
  // Strip a leading UTF-8 BOM before the first-line check: editors add it
  // invisibly and it would otherwise mask a correct import shim.
  const existing = raw.startsWith('\uFEFF') ? raw.slice(1) : raw;
  const newlineAt = existing.indexOf('\n');
  const firstLine = (newlineAt === -1 ? existing : existing.slice(0, newlineAt)).trimEnd();
  if (firstLine === SHIM_IMPORT_LINE) {
    return { file: null, warning: null, status: 'merged' };
  }
  return {
    file: null,
    warning: {
      code: 'HH-W005',
      severity: 'warn',
      message:
        `${path} exists but does not begin with the "${SHIM_IMPORT_LINE}" import; ` +
        'left untouched — it is a conflicting instruction source that init (C3) resolves',
      providerId,
    },
    status: 'skipped',
  };
}
