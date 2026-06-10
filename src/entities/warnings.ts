/**
 * Warning catalogue — F3 (#6), PRD §11.
 * HH-W002 ("skill-less provider") is retired as of v0.3: every v1 provider
 * consumes Agent Skills, so the code must not be redefined.
 */

export type WarningCode =
  | 'HH-W001'
  | 'HH-W003'
  | 'HH-W004'
  | 'HH-W005'
  | 'HH-W006'
  | 'HH-W010'
  | 'HH-W011';

export type WarningSeverity = 'warn' | 'error';

export interface Warning {
  code: WarningCode;
  severity: WarningSeverity;
  message: string;
  /** Repo-relative path of the canonical source that triggered the warning. */
  canonicalPath?: string;
  /** Provider the warning applies to, when provider-specific. */
  providerId?: string;
}

/** One-line summary per code; the long explanation lives at `docs/warnings/<code>.md`. */
export const WARNING_CATALOGUE: Readonly<Record<WarningCode, string>> = {
  'HH-W001': 'lossy glob downgrade',
  'HH-W003': 'hook event unmappable for a provider',
  'HH-W004': 'provider size cap exceeded',
  'HH-W005': 'duplicate hook sources detected in provider config',
  'HH-W006': 'deprecated provider config key detected',
  'HH-W010': 'unknown attachment under .agents/',
  'HH-W011': 'frontmatter in AGENTS.md leaks verbatim into provider prompts',
};

export const WARNING_CODES: readonly WarningCode[] = Object.keys(
  WARNING_CATALOGUE,
) as WarningCode[];

/** Repo-relative path of the explanation page for a warning code. */
export function warningDocPath(code: WarningCode): string {
  return `docs/warnings/${code}.md`;
}
