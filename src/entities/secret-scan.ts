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
 *                private key, JWT, vendor tokens), a long hex secret next to
 *                a credential keyword, or a high-entropy string next to such
 *                a keyword. A high finding HARD-BLOCKS the run by default
 *                (U2); `--assist-allow-secret <rule>` instead redacts the
 *                span to a stable `[REDACTED:<rule>]` placeholder (EV2) —
 *                block is the default, redaction is the opt-out.
 *   - `medium` — sensitive-but-not-credential markers (RFC1918 addresses,
 *                email addresses). Surfaced as warnings in the disclosure,
 *                never blocking.
 *
 * Findings carry byte offsets into the ORIGINAL content (so redaction is
 * exact) and a MASKED excerpt — the raw matched secret is never echoed back.
 *
 * Hardening (from the C5 adversarial review):
 *   - Shape rules match their distinctive prefix ANYWHERE, not behind a
 *     `\b`. A `\b` is absent at `key=xAKIA…` (letter glued before the
 *     token), so the old anchors let a real credential glued after a word
 *     char slip past entirely. The OpenAI `sk-` prefix is the one ambiguous
 *     short prefix (it occurs inside ordinary words like `task-…`), so that
 *     rule additionally requires the matched body to clear the entropy floor.
 *   - A format/zero-width pre-pass (`\p{Cf}` stripped, offsets mapped back)
 *     stops an invisible char from splitting a token mid-prefix.
 *   - Keyword adjacency spans the candidate's line PLUS the preceding line,
 *     with all line-ending styles (LF/CRLF/CR) normalized, so a secret
 *     documented on the line under its keyword (or in a CRLF file) is caught.
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
  /** Regex SOURCE (no flags); compiled with `gu` per scan. */
  pattern: string;
  /**
   * When true the rule only fires when the candidate's keyword window (its
   * line plus the preceding line) matches `SECRET_KEYWORD_RE` — the
   * `token|secret|password|api[_-]?key|credential` adjacency from the threat
   * model. Used by the generic high-entropy and long-hex rules.
   */
  requiresKeyword?: boolean;
  /**
   * When true the matched span must clear `ENTROPY_THRESHOLD`. Filters
   * low-entropy false positives — e.g. an ordinary `task-oriented-…` phrase
   * that otherwise satisfies the OpenAI `sk-` shape.
   */
  requiresEntropy?: boolean;
}

/** One secret found in content that would otherwise leave the machine. */
export interface SecretFinding {
  ruleId: string;
  severity: SecretSeverity;
  /** Repo-relative path the content came from (for block messages). */
  path: string;
  /** 1-based line of the match start (in the original content). */
  line: number;
  /** Character offsets of the matched span within the ORIGINAL content. */
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
 * Keyword adjacency for the generic high-entropy and long-hex rules. The
 * candidate's keyword WINDOW (its own line plus the line above it) must
 * mention a credential-ish word.
 */
const SECRET_KEYWORD_RE = /token|secret|passwd|password|api[_-]?key|credential/i;

/**
 * Shannon-entropy floor (bits/char). A random base64 string sits near 6;
 * English prose near 4 only for very mixed text; URL/path-ish strings
 * typically land 3–3.9. 4.0 + the keyword/length requirements keeps ordinary
 * prose out.
 */
const ENTROPY_THRESHOLD = 4.0;

/**
 * Built-in rule set, per the threat model's enumerated high-confidence list.
 * Order matters only for overlapping vendor prefixes: `anthropic-api-key`
 * (`sk-ant-…`) precedes `openai-api-key` (`sk-…`), which also excludes the
 * `ant-` infix via lookahead — both orderings are safe, but keeping the more
 * specific rule first makes the intent explicit.
 *
 * Shape rules carry NO leading word-boundary on purpose (see the module
 * doc-comment): a distinctive prefix glued after a word char must still
 * match. The trailing run is greedy; over-matching is the fail-closed
 * direction for a secret gate.
 */
export const BUILTIN_SECRET_RULES: readonly SecretRule[] = [
  {
    id: 'aws-access-key-id',
    description: 'AWS access key id (AKIA/ASIA…)',
    severity: 'high',
    pattern: '(?:AKIA|ASIA)[0-9A-Z]{16}',
  },
  {
    id: 'pem-private-key',
    description: 'PEM private key block',
    severity: 'high',
    pattern: '-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----',
  },
  {
    id: 'jwt',
    description: 'JSON Web Token',
    severity: 'high',
    pattern: 'eyJ[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}\\.[A-Za-z0-9_-]{8,}',
  },
  {
    id: 'github-token',
    description: 'GitHub token (ghp_/gho_/ghu_/ghs_/ghr_/github_pat_)',
    severity: 'high',
    pattern: '(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})',
  },
  {
    id: 'gitlab-pat',
    description: 'GitLab personal access token (glpat-…)',
    severity: 'high',
    pattern: 'glpat-[A-Za-z0-9_-]{20,}',
  },
  {
    id: 'slack-token',
    description: 'Slack token (xoxb-/xoxa-/xoxp-/xoxr-/xoxs-…)',
    severity: 'high',
    pattern: 'xox[baprs]-[A-Za-z0-9-]{10,}',
  },
  {
    id: 'google-api-key',
    description: 'Google API key (AIza…)',
    severity: 'high',
    // `{35,}` not `{35}`: a slightly-overlong AIza-shaped token should still
    // BLOCK (over-matching is the fail-closed direction for a secret gate).
    pattern: 'AIza[0-9A-Za-z_-]{35,}',
  },
  {
    id: 'anthropic-api-key',
    description: 'Anthropic API key (sk-ant-…)',
    severity: 'high',
    pattern: 'sk-ant-[A-Za-z0-9_-]{20,}',
  },
  {
    id: 'openai-api-key',
    description: 'OpenAI API key (sk-…)',
    severity: 'high',
    // `sk-` is short and occurs inside ordinary words (`task-`, `risk-`), so
    // unlike the other shape rules this one also requires the matched body to
    // clear the entropy floor — a real key is random, a word-chain is not.
    pattern: 'sk-(?!ant-)[A-Za-z0-9_-]{20,}',
    requiresEntropy: true,
  },
  {
    id: 'npm-token',
    description: 'npm access token (npm_…)',
    severity: 'high',
    // `{36,}` for the same fail-closed reason as `google-api-key`.
    pattern: 'npm_[A-Za-z0-9]{36,}',
  },
  {
    id: 'hex-secret',
    description: 'long hexadecimal secret on a line mentioning a credential keyword',
    severity: 'high',
    // 32+ hex chars caps Shannon entropy at 4.0 (16 symbols), so the generic
    // high-entropy rule's floor just misses 64-hex CI tokens / hex-encoded
    // keys. A dedicated keyword-gated hex rule catches them without an
    // entropy test. Keyword adjacency keeps ordinary git SHAs (no keyword) out.
    pattern: '[0-9a-fA-F]{32,}',
    requiresKeyword: true,
  },
  {
    id: 'high-entropy-string',
    description:
      'high-entropy string on a line mentioning token/secret/password/api key/credential',
    severity: 'high',
    // `.` and `:` are in the class so a dotted/segmented high-entropy value
    // (e.g. `aB3.xK9.mQ7.…`) forms one run rather than slipping between dots.
    pattern: '[A-Za-z0-9+/=_.:-]{20,}',
    requiresKeyword: true,
    requiresEntropy: true,
  },
  {
    id: 'rfc1918-ip',
    description: 'private (RFC1918) IP address',
    severity: 'medium',
    pattern:
      '(?:10\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}|192\\.168\\.\\d{1,3}\\.\\d{1,3}|172\\.(?:1[6-9]|2\\d|3[01])\\.\\d{1,3}\\.\\d{1,3})',
  },
  {
    id: 'email-address',
    description: 'email address',
    severity: 'medium',
    pattern: '[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}',
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

/**
 * Keyword window for adjacency checks: the substring covering the line that
 * contains `index` PLUS the line immediately above it. Line ends are LF, CR,
 * or CRLF — all treated as separators, so a CRLF/old-Mac file is handled and
 * a secret on the line under its keyword is in range. (Threat-model wording
 * is "adjacent", not "same line".)
 */
function keywordWindow(content: string, index: number): string {
  const isEol = (ch: string | undefined): boolean => ch === '\n' || ch === '\r';
  let lineStart = index;
  while (lineStart > 0 && !isEol(content[lineStart - 1])) {
    lineStart--;
  }
  let lineEnd = index;
  while (lineEnd < content.length && !isEol(content[lineEnd])) {
    lineEnd++;
  }
  let windowStart = lineStart;
  if (windowStart > 0) {
    windowStart--; // step over the separator before the current line
    while (windowStart > 0 && !isEol(content[windowStart - 1])) {
      windowStart--;
    }
  }
  return content.slice(windowStart, lineEnd);
}

/**
 * Strips Unicode format/zero-width code points (category `Cf`: ZWSP, ZWNJ,
 * ZWJ, BOM, …) so an invisible char cannot split a token mid-prefix and
 * evade the shape rules. Returns the cleaned string and a map from each
 * cleaned-string index to its index in the ORIGINAL content, so findings can
 * be reported (and redacted) against the original bytes.
 */
function stripFormatChars(content: string): { cleaned: string; map: number[] } {
  const FORMAT_CHAR = /\p{Cf}/u;
  let cleaned = '';
  const map: number[] = [];
  // Iterate by code point so astral chars are not split.
  let i = 0;
  for (const ch of content) {
    if (!FORMAT_CHAR.test(ch)) {
      cleaned += ch;
      for (let k = 0; k < ch.length; k++) {
        map.push(i + k);
      }
    }
    i += ch.length;
  }
  return { cleaned, map };
}

/**
 * Scans `content` (attributed to `path` for reporting) against the built-in
 * rule set plus any `extraRules`, minus `suppressRules`. Returns findings
 * sorted by position, with offsets into the ORIGINAL content.
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
  // Scan a format-char-stripped copy so invisible chars cannot split tokens;
  // map every reported offset back to the original content for exact redaction.
  const { cleaned, map } = stripFormatChars(content);
  const toOriginalStart = (cleanIndex: number): number =>
    cleanIndex < map.length ? map[cleanIndex]! : content.length;
  const toOriginalEnd = (cleanEndExclusive: number): number =>
    cleanEndExclusive > 0 && cleanEndExclusive - 1 < map.length
      ? map[cleanEndExclusive - 1]! + 1
      : content.length;

  const findings: SecretFinding[] = [];
  for (const rule of rules) {
    const re = new RegExp(rule.pattern, 'gu');
    for (const match of cleaned.matchAll(re)) {
      const text = match[0];
      const cleanStart = match.index;
      if (rule.requiresKeyword === true && !SECRET_KEYWORD_RE.test(keywordWindow(cleaned, cleanStart))) {
        continue;
      }
      if (rule.requiresEntropy === true && shannonEntropy(text) < ENTROPY_THRESHOLD) {
        continue;
      }
      const start = toOriginalStart(cleanStart);
      findings.push({
        ruleId: rule.id,
        severity: rule.severity,
        path,
        line: lineAt(content, start),
        start,
        end: toOriginalEnd(cleanStart + text.length),
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
