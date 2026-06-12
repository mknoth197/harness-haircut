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
  | 'HH-W007'
  | 'HH-W010'
  | 'HH-W011'
  | 'HH-W012'
  | 'HH-W013';

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
  'HH-W005': 'conflicting or duplicate provider configuration source detected',
  'HH-W006': 'deprecated provider config key detected',
  'HH-W007': 'canonical surface unrepresentable for provider',
  'HH-W010': 'unknown attachment under .agents/',
  'HH-W011': 'frontmatter in AGENTS.md leaks verbatim into provider prompts',
  'HH-W012': 'canonical source excluded by .gitignore',
  'HH-W013': 'provider path skipped: a symlink aliases it onto another repo path',
};

/**
 * HH-W013 (#35): a provider projection path resolves through an in-repo
 * symlinked parent directory onto ANOTHER repo path — typically a canonical
 * source (`.claude/skills/x` → `.agents/skills/x` is a common hand-rolled
 * consolidation pattern). Writing the projection there would overwrite the
 * symlink's target, so `audit` and `apply` both refuse to manage the path and
 * mint this warning instead. Shared so the two use cases stay word-for-word
 * consistent.
 */
export function symlinkAliasWarning(
  path: string,
  resolvedPath: string,
  providerId: string,
): Warning {
  return {
    code: 'HH-W013',
    severity: 'warn',
    message:
      `${path} resolves through an in-repo symlink to ${resolvedPath}, so writing ` +
      'the projection would overwrite that file instead. The path is skipped ' +
      `(not audited, never written). Remove the symlink to let apply own ${path} ` +
      'as a real file, or disable the provider.',
    providerId,
  };
}

export const WARNING_CODES: readonly WarningCode[] = Object.keys(
  WARNING_CATALOGUE,
) as WarningCode[];

/** Repo-relative path of the explanation page for a warning code. */
export function warningDocPath(code: WarningCode): string {
  return `docs/warnings/${code}.md`;
}
