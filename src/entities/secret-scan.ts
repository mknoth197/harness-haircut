/**
 * Pure secret scanner for the `init --assist` egress path — C5 (#30) U2/EV2,
 * layer 1 (entities): no I/O, no imports, deterministic.
 *
 * Scans every byte that WOULD leave the machine (the post-classification
 * candidate texts) for credentials and sensitive markers, per the Fable
 * threat model (`docs/security/assist-egress-threat-model.md`). The rule set
 * is regex + Shannon entropy only (no ML — C5 out-of-scope), with two
 * severities:
 *
 *   - `high`   — a credential with a recognizable shape (AWS key id, PEM
 *                private key, JWT, vendor tokens, high-entropy string next to
 *                a `token|secret|…` keyword). A high finding HARD-BLOCKS the
 *                run by default (U2); `--assist-allow-secret <rule>` instead
 *                redacts the span to a stable `[REDACTED:<rule>]` placeholder
 *                (EV2) — block is the default, redaction is the opt-out.
 *   - `medium` — sensitive-but-not-credential markers (RFC1918 addresses,
 *                email addresses). Surfaced as warnings in the disclosure,
 *                never blocking.
 *
 * Findings carry byte offsets (so redaction is exact) and a MASKED excerpt —
 * the raw matched secret is never echoed back into a report or preview.
 */

export type SecretSeverity = 'high' | 'medium';

/**
 * One scan rule. `id` is the stable, user-facing handle: it appears in block
 * messages, in `[REDACTED:<id>]` placeholders, and as the argument to
 * `--assist-allow-secret <id>` — renaming an id is a breaking change.
 */
export interface SecretRule {
  id: string;
  description: string;
  severity: SecretSeverity;
  /** Regex SOURCE (no flags); compiled with `g` per scan. */
  pattern: string;
  /**
   * When true the rule only fires on lines that also match
   * `SECRET_KEYWORD_RE` (the `token|secret|password|api key|credential`
   * adjacency requirement from the threat model) AND the matched span clears
   * `ENTROPY_THRESHOLD`. Used by the generic high-entropy rule to keep false
   * positives down; shape-specific rules (AWS/PEM/JWT/…) skip both checks.
   */
  requiresKeywordAndEntropy?: boolean;
}

/** One secret found in content that would otherwise leave the machine. */
export interface SecretFinding {
  ruleId: string;
  severity: SecretSeverity;
  /** Repo-relative path the content came from (for block messages). */
  path: string;
  /** 1-based line of the match start. */
  line: number;
  /** Character offsets of the matched span within the scanned content. */
  start: number;
  end: number;
  /**
   * Masked display form: first 4 chars of the match + `…` — NEVER the whole
   * secret (a block message must not itself leak the credential).
   */
  excerpt: string;
}

/** Extension/suppression hooks for the rule set (C5 acceptance: configurable). */
export interface SecretScanOptions {
  /** Extra rules appended after the built-ins (same matching semantics). */
  extraRules?: readonly SecretRule[];
  /** Rule ids to skip entirely (suppression — distinct from allow/redact). */
  suppressRules?: readonly string[];
}

/**
 * Keyword adjacency for the generic high-entropy rule: the line containing
 * the candidate must mention a credential-ish word (threat-model wording:
 * "high-entropy strings adjacent to token|secret|password|api_key|credential").
 */
const SECRET_KEYWORD_RE = /token|secret|passwd|password|api[_-]?key|credential/i;

/**
 * Shannon-entropy floor (bits/char) for the generic high-entropy rule. A
 * random base64 string sits near 6; English prose near 4 only for very mixed
 * text; URL/path-ish strings typically land 3–3.9. 4.0 + the keyword
 * requirement + a 20-char minimum keeps ordinary prose and paths out.
 */
const ENTROPY_THRESHOLD = 4.0;

/**
 * Built-in rule set, per the threat model's enumerated high-confidence list.
 * Order matters only for overlapping vendor prefixes: `anthropic-api-key`
 * (`sk-ant-…`) must precede `openai-api-key` (`sk-…`), which excludes the
 * `ant-` infix via lookahead anyway — both orderings are safe, but keeping
 * the more specific rule first makes the intent explicit.
 */
export const BUILTIN_SECRET_RULES: readonly SecretRule[] = [
  {
    id: 'aws-access-key-id',
    description: 'AWS access key id (AKIA/ASIA…)',
    severity: 'high',
    pattern: '\\b(?:AKIA|ASIA)[0-9A-Z]{16}\\b',
  },
  {
    id: 'pem-private-key',
    description: 'PEM private key block',
    severity: 'high',
    pattern: '-----BEGIN (?:[A-Z]+ )*PRIVATE KEY-----',
  },
  {
    id: 'jwt',
    description: 'JSON Web Token',
    severity: 'high',
    pattern: '\\beyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\b',
  },
  {
    id: 'github-token',
    description: 'GitHub token (ghp_/gho_/ghu_/ghs_/ghr_/github_pat_)',
    severity: 'high',
    pattern: '\\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\\b',
  },
  {
    id: 'gitlab-pat',
    description: 'GitLab personal access token (glpat-…)',
    severity: 'high',
    pattern: '\\bglpat-[A-Za-z0-9_-]{20,}\\b',
  },
  {
    id: 'slack-token',
    description: 'Slack token (xoxb-/xoxa-/xoxp-/xoxr-/xoxs-…)',
    severity: 'high',
    pattern: '\\bxox[baprs]-[A-Za-z0-9-]{10,}\\b',
  },
  {
    id: 'google-api-key',
    description: 'Google API key (AIza…)',
    severity: 'high',
    // `{35,}` not `{35}`: a slightly-overlong AIza-shaped token should still
    // BLOCK (over-matching is the fail-closed direction for a secret gate).
    pattern: '\\bAIza[0-9A-Za-z_-]{35,}\\b',
  },
  {
    id: 'anthropic-api-key',
    description: 'Anthropic API key (sk-ant-…)',
    severity: 'high',
    pattern: '\\bsk-ant-[A-Za-z0-9_-]{20,}\\b',
  },
  {
    id: 'openai-api-key',
    description: 'OpenAI API key (sk-…)',
    severity: 'high',
    pattern: '\\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\\b',
  },
  {
    id: 'npm-token',
    description: 'npm access token (npm_…)',
    severity: 'high',
    // `{36,}` for the same fail-closed reason as `google-api-key`.
    pattern: '\\bnpm_[A-Za-z0-9]{36,}\\b',
  },
  {
    id: 'high-entropy-string',
    description:
      'high-entropy string on a line mentioning token/secret/password/api key/credential',
    severity: 'high',
    pattern: '[A-Za-z0-9+/=_-]{20,}',
    requiresKeywordAndEntropy: true,
  },
  {
    id: 'rfc1918-ip',
    description: 'private (RFC1918) IP address',
    severity: 'medium',
    pattern:
      '\\b(?:10\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}|192\\.168\\.\\d{1,3}\\.\\d{1,3}|172\\.(?:1[6-9]|2\\d|3[01])\\.\\d{1,3}\\.\\d{1,3})\\b',
  },
  {
    id: 'email-address',
    description: 'email address',
    severity: 'medium',
    pattern: '\\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}\\b',
  },
];

/** Shannon entropy in bits per character. Empty string → 0. */
export function shannonEntropy(s: string): number {
  if (s.length === 0) {
    return 0;
  }
  const counts = new Map<string, number>();
  for (const ch of s) {
    counts.set(ch, (counts.get(ch) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / s.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/** First 4 chars of the match + `…` — the display form that never leaks. */
function maskExcerpt(match: string): string {
  return `${match.slice(0, 4)}…`;
}

/** 1-based line number of character offset `index` within `content`. */
function lineAt(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i++) {
    if (content[i] === '\n') {
      line++;
    }
  }
  return line;
}

/** Bounds of the line containing offset `index` (for keyword adjacency). */
function lineSpanAt(content: string, index: number): { start: number; end: number } {
  const start = content.lastIndexOf('\n', index - 1) + 1;
  const newline = content.indexOf('\n', index);
  return { start, end: newline === -1 ? content.length : newline };
}

/**
 * Scans `content` (attributed to `path` for reporting) against the built-in
 * rule set plus any `extraRules`, minus `suppressRules`. Returns findings
 * sorted by position. Overlapping findings are all reported — the redactor
 * resolves overlaps; the block message benefits from naming every rule.
 *
 * Throws only on an invalid rule pattern (e.g. a malformed `extraRules`
 * regex) — callers on the egress path MUST treat a throw as fail-closed
 * (block the send), never send-on-error (UN1).
 */
export function scanForSecrets(
  path: string,
  content: string,
  options?: SecretScanOptions,
): SecretFinding[] {
  const suppress = new Set(options?.suppressRules ?? []);
  const rules = [...BUILTIN_SECRET_RULES, ...(options?.extraRules ?? [])].filter(
    (rule) => !suppress.has(rule.id),
  );
  const findings: SecretFinding[] = [];
  for (const rule of rules) {
    const re = new RegExp(rule.pattern, 'g');
    for (const match of content.matchAll(re)) {
      const text = match[0];
      const start = match.index;
      if (rule.requiresKeywordAndEntropy === true) {
        const span = lineSpanAt(content, start);
        const line = content.slice(span.start, span.end);
        if (!SECRET_KEYWORD_RE.test(line) || shannonEntropy(text) < ENTROPY_THRESHOLD) {
          continue;
        }
      }
      findings.push({
        ruleId: rule.id,
        severity: rule.severity,
        path,
        line: lineAt(content, start),
        start,
        end: start + text.length,
        excerpt: maskExcerpt(text),
      });
    }
  }
  return findings.sort((a, b) => a.start - b.start || a.end - b.end);
}

/**
 * Replaces each finding's span with the stable `[REDACTED:<rule>]`
 * placeholder (EV2). Spans are applied right-to-left so earlier offsets stay
 * valid; overlapping findings collapse into the leftmost-starting one's
 * placeholder (the overlap region is removed either way — nothing of the
 * secret survives). Callers pass ONLY the findings whose rules the user
 * explicitly allowed (`--assist-allow-secret`); everything else must have
 * blocked the run before redaction is even attempted.
 */
export function redactFindings(content: string, findings: readonly SecretFinding[]): string {
  const ordered = [...findings].sort((a, b) => a.start - b.start || a.end - b.end);
  // Merge overlaps left-to-right, keeping the first rule's id for the label.
  const merged: { start: number; end: number; ruleId: string }[] = [];
  for (const finding of ordered) {
    const last = merged[merged.length - 1];
    if (last !== undefined && finding.start < last.end) {
      last.end = Math.max(last.end, finding.end);
    } else {
      merged.push({ start: finding.start, end: finding.end, ruleId: finding.ruleId });
    }
  }
  let result = content;
  for (let i = merged.length - 1; i >= 0; i--) {
    const span = merged[i]!;
    result = `${result.slice(0, span.start)}[REDACTED:${span.ruleId}]${result.slice(span.end)}`;
  }
  return result;
}
