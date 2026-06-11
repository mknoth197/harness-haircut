/**
 * Egress policy for `init --assist` — C5 (#30) U1/EV1/OPT1/UN1, layer 1
 * (entities): pure classification + planning, no I/O.
 *
 * `--assist` sends file CONTENTS to a third-party model provider. Per the
 * Fable threat model (`docs/security/assist-egress-threat-model.md`), the
 * canonical/provider trees plausibly hold secrets (tokens in hook scripts,
 * MCP URLs in settings JSON), internal hostnames, and PII — so egress is
 * DEFAULT-DENY by file class, with instruction *prose* the only allow:
 *
 *   allow   — instruction prose: `AGENTS.md`/`CLAUDE.md`/`GEMINI.md` (root or
 *             nested), `.github/copilot-instructions.md`,
 *             `.agents/instructions/**.md`, `.github/instructions/**.md`,
 *             `.claude/rules/**.md`. The only thing the merge reasons about.
 *   opt-in  — skill bodies: `{.agents,.claude,.codex}/skills/<name>/SKILL.md`.
 *             Skill bodies embed example calls / internal URLs — sent only on
 *             an explicit per-file opt-in or `--assist-include`.
 *   deny    — everything else, EXPLICITLY including hook scripts
 *             (`.agents/hooks/**`), provider settings/hook JSON, skill
 *             sibling attachments, tool state (`.agents/.harness-state.json`),
 *             init backups (`.harness-haircut-init-backup/**`), non-UTF-8
 *             content, and any path no rule recognizes (the catch-all).
 *             `--assist-include <glob>` is the ONLY way to send a denied
 *             class (EV1) and every file it pulls in is individually
 *             enumerated in the disclosure.
 *
 * The policy runs on the resolver CANDIDATE bytes — classification prefers
 * the contradiction slot (`root-instructions`/`fragment:*` = prose,
 * `skill:*` = opt-in) and falls back to the path rules above — BEFORE any
 * backend sees them. Planning is fail-closed (UN1): a scanner error blocks
 * the send; it never sends-on-error.
 */
import type { SecretFinding, SecretScanOptions } from './secret-scan.js';
import { scanForSecrets, redactFindings } from './secret-scan.js';

export type EgressClass = 'allow' | 'opt-in' | 'deny';

/** Restrictiveness order: deny is the most restrictive, allow the least. */
const CLASS_RANK: Record<EgressClass, number> = { deny: 0, 'opt-in': 1, allow: 2 };

/** Returns whichever class is the more restrictive (used to combine path+slot). */
function moreRestrictive(a: EgressClass, b: EgressClass): EgressClass {
  return CLASS_RANK[a] <= CLASS_RANK[b] ? a : b;
}

/** Replacement char — its presence means the source bytes were not valid UTF-8. */
const NON_UTF8_MARKER = '�';

/**
 * True when content is not safe text to egress: malformed-UTF-8 (a U+FFFD
 * replacement char survived decoding) or an embedded NUL. This veto is
 * ABSOLUTE — unlike a class-based `deny`, it can never be overridden by
 * `--assist-include`/opt-in: a binary blob is never instruction prose.
 */
function hasBinaryContent(content: string): boolean {
  return content.includes(NON_UTF8_MARKER) || content.includes('\u0000');
}

/** Path segments that hard-deny a file regardless of its basename. */
const DENY_SEGMENTS = new Set([
  // Skill folders: only the SKILL.md *body* is opt-in (handled below); every
  // sibling/attachment (scripts, `.env`, assets) is hard-denied — highest
  // secret density per the threat model. A `skills` segment anywhere triggers.
  'skills',
  // Hook script dirs (`.agents/hooks/`, `.github/hooks/`, …): executable,
  // deploy creds / internal hosts. A `hooks` segment anywhere triggers.
  'hooks',
  // init's non-chosen-candidate backups, at any depth (the dir is matched as
  // an exact SEGMENT so a look-alike like `…-init-backup-not/` does not).
  '.harness-haircut-init-backup',
]);

/**
 * Path-class rules; no match → deny (default-deny catch-all). The deny rules
 * are SEGMENT-aware and run BEFORE any allow, so a prose basename can never
 * win inside a deny-class directory: `.agents/skills/foo/CLAUDE.md` (a skill
 * sibling that happens to be named like a shim), `pkg/.harness-haircut-init-backup/AGENTS.md`
 * (a nested backup), and `.agents/hooks/x.md` all deny.
 */
function classifyByPath(path: string): EgressClass {
  // Match case-INSENSITIVELY. On macOS/Windows the filesystem is
  // case-insensitive, so `.agents/Skills/…` is the SAME on-disk directory as
  // `.agents/skills/…`; a case-exact deny check would let a capital-S variant
  // escape the skill/hook/backup deny and win a prose-suffix allow. Lowercasing
  // for classification keeps deny authoritative; over-allowing a case-variant
  // prose file (on a case-sensitive FS) is benign — it is still prose.
  const lower = path.toLowerCase();
  const segments = lower.split('/');
  // Exact hard-deny files named by the threat model (settings / hook JSON /
  // tool state). Checked first so they deny even outside a deny segment.
  if (
    lower === '.claude/settings.json' ||
    lower === '.codex/hooks.json' ||
    lower === '.codex/config.toml' ||
    lower === '.gemini/settings.json' ||
    lower === '.agents/.harness-state.json'
  ) {
    return 'deny';
  }
  // Skill BODY (opt-in): exactly `<root>/skills/<name>/SKILL.md`. Checked
  // before the `skills` deny-segment rule so the body itself stays opt-in
  // while every sibling under the folder denies.
  for (const root of ['.agents/skills/', '.claude/skills/', '.codex/skills/']) {
    if (lower.startsWith(root) && lower.endsWith('/skill.md')) {
      const rest = lower.slice(root.length, -'/skill.md'.length);
      if (rest !== '' && !rest.includes('/')) {
        return 'opt-in';
      }
    }
  }
  // Deny any path that travels through a deny-class directory segment.
  for (const segment of segments) {
    if (DENY_SEGMENTS.has(segment)) {
      return 'deny';
    }
  }
  // Instruction prose (allow): root shims (exact) + AGENTS.md at any depth
  // (the threat model: "AGENTS.md root+nested"). A nested CLAUDE.md/GEMINI.md
  // is NOT a thing this tool emits, so those allow only at the repo root.
  if (lower === 'agents.md' || lower.endsWith('/agents.md')) {
    return 'allow';
  }
  if (lower === 'claude.md' || lower === 'gemini.md' || lower === '.github/copilot-instructions.md') {
    return 'allow';
  }
  // Scoped instruction fragments (allow) — `.md` only; anything else that
  // strays into these directories falls through to the deny catch-all.
  if (
    (lower.startsWith('.agents/instructions/') ||
      lower.startsWith('.github/instructions/') ||
      lower.startsWith('.claude/rules/')) &&
    lower.endsWith('.md')
  ) {
    return 'allow';
  }
  return 'deny';
}

/**
 * Classification by contradiction slot — the primary key for resolver
 * candidates (the threat model: `root-instructions`/`fragment:*` = prose →
 * allow; `skill:*` = SKILL.md body → opt-in). Unknown slot kinds deny, so a
 * future slot namespace is fail-closed until classified here deliberately.
 */
export function classifyCandidateSlot(slot: string): EgressClass {
  if (slot === 'root-instructions' || slot.startsWith('fragment:')) {
    return 'allow';
  }
  if (slot.startsWith('skill:')) {
    return 'opt-in';
  }
  return 'deny';
}

/**
 * Classification for one egress candidate. The result is the MORE RESTRICTIVE
 * of the path class and (when a slot is present) the slot class — a slot may
 * only ever NARROW the path policy, never widen it. This closes the
 * slot-short-circuit the C5 review found: a hard-denied path
 * (`.claude/settings.json`) carried under a benign `root-instructions` slot
 * stays denied, because the path veto is authoritative for the deny classes.
 *
 * Non-UTF-8 content (replacement chars survived decoding) or an embedded NUL
 * hard-denies regardless of class — binary blobs are never instruction prose.
 * (The byte-true guarantee is enforced at the C4 read boundary, which decodes
 * with replacement so malformed bytes surface as U+FFFD here.)
 */
export function classifyEgress(input: {
  path: string;
  slot?: string;
  content: string;
}): EgressClass {
  if (input.content.includes(NON_UTF8_MARKER) || input.content.includes('\u0000')) {
    return 'deny';
  }
  const pathClass = classifyByPath(input.path);
  if (input.slot === undefined) {
    return pathClass;
  }
  return moreRestrictive(pathClass, classifyCandidateSlot(input.slot));
}

/** Caps for `--assist-include` patterns (threat-model finding 3: bounded globs). */
const MAX_GLOB_LENGTH = 256;
const MAX_GLOB_WILDCARDS = 16;

/**
 * Matches one path SEGMENT against one pattern segment, where `*` matches any
 * run of chars within the segment and `?` matches one. This is the classic
 * LINEAR glob matcher (single greedy star with one backtrack pointer) — no
 * nested quantifiers, so no catastrophic backtracking. `**` is handled a
 * level up by `matchSegments`, never here.
 */
function matchSegment(pat: string, str: string): boolean {
  let p = 0;
  let s = 0;
  let star = -1;
  let mark = 0;
  while (s < str.length) {
    if (p < pat.length && (pat[p] === str[s] || pat[p] === '?')) {
      p++;
      s++;
    } else if (p < pat.length && pat[p] === '*') {
      star = p;
      mark = s;
      p++;
    } else if (star !== -1) {
      p = star + 1;
      mark++;
      s = mark;
    } else {
      return false;
    }
  }
  while (p < pat.length && pat[p] === '*') {
    p++;
  }
  return p === pat.length;
}

/**
 * Segment-wise glob match with memoization. A globstar consumes zero or more
 * whole path segments; every other pattern segment must match exactly one
 * path segment via `matchSegment`. The `failed` memo (keyed on the (pi, si)
 * pair) makes this O(patternSegments × pathSegments) — it CANNOT exhibit the
 * exponential blow-up the previous adjacent-globstar regex did on stacked
 * globstar patterns (threat-model finding 3).
 */
function matchSegments(pat: readonly string[], path: readonly string[]): boolean {
  const failed = new Set<number>();
  const stride = path.length + 1;
  const go = (pi: number, si: number): boolean => {
    if (pi === pat.length) {
      return si === path.length;
    }
    const key = pi * stride + si;
    if (failed.has(key)) {
      return false;
    }
    let result: boolean;
    if (pat[pi] === '**') {
      // Try consuming 0..N remaining segments with this `**`.
      result = false;
      for (let k = si; k <= path.length; k++) {
        if (go(pi + 1, k)) {
          result = true;
          break;
        }
      }
    } else if (si < path.length && matchSegment(pat[pi]!, path[si]!)) {
      result = go(pi + 1, si + 1);
    } else {
      result = false;
    }
    if (!result) {
      failed.add(key);
    }
    return result;
  };
  return go(0, 0);
}

/**
 * Minimal bounded glob for `--assist-include`: `**` crosses segments, `*`
 * and `?` stay within one. Comparison is over repo-relative POSIX paths. A
 * pattern over the length/wildcard caps matches NOTHING (fail-closed: a
 * hostile or runaway pattern cannot widen egress, only fail to). Matching is
 * linear-time (`matchSegments`), so an adversarial pattern cannot hang the
 * CLI either — it can only fail to match.
 */
export function matchesGlob(pattern: string, path: string): boolean {
  if (pattern.length > MAX_GLOB_LENGTH) {
    return false;
  }
  let wildcards = 0;
  for (const ch of pattern) {
    if (ch === '*' || ch === '?') {
      wildcards++;
    }
  }
  if (wildcards > MAX_GLOB_WILDCARDS) {
    return false;
  }
  // Collapse runs of adjacent `**` segments (`**/**/…` ≡ `**`) so a stacked
  // pattern reduces to a single globstar before matching.
  const patSegments: string[] = [];
  for (const segment of pattern.split('/')) {
    if (segment === '**' && patSegments[patSegments.length - 1] === '**') {
      continue;
    }
    patSegments.push(segment);
  }
  return matchSegments(patSegments, path.split('/'));
}

/** One candidate file/text under egress consideration. */
export interface EgressFileInput {
  /** Repo-relative POSIX path (the disclosure names exactly this). */
  path: string;
  /** Contradiction slot when the bytes are a resolver candidate. */
  slot?: string;
  /** The exact text that would be sent (pre-redaction). */
  content: string;
}

/** Flags/interactive choices that widen or narrow the default policy. */
export interface EgressFlags {
  /** EV1 — `--assist-include <glob>`: makes denied/opt-in classes eligible. */
  include: readonly string[];
  /** Paths the user explicitly opted in interactively (opt-in class only). */
  optInPaths: readonly string[];
  /** EV2 — `--assist-allow-secret <rule>`: redact instead of block, per rule. */
  allowSecretRules: readonly string[];
}

export function defaultEgressFlags(): EgressFlags {
  return { include: [], optInPaths: [], allowSecretRules: [] };
}

/** The per-file outcome the disclosure renders. */
export interface EgressFileDecision {
  path: string;
  slot?: string;
  class: EgressClass;
  /** True when the file's (post-redaction) bytes will be sent. */
  included: boolean;
  /** EV1 — true when only an `--assist-include` pattern made it eligible. */
  viaInclude: boolean;
  /** Exact byte count (UTF-8) of `content` — 0 when not included. */
  bytes: number;
  /** The exact post-redaction text to send — empty when not included. */
  content: string;
  /** Scan findings on the ORIGINAL content (included files only). */
  findings: SecretFinding[];
  /** Rule ids that were redacted (subset of flags.allowSecretRules). */
  redactedRules: string[];
}

/** The complete, fail-closed egress decision for one assist call. */
export interface EgressPlan {
  /** `blocked` when any unallowed high-confidence secret was found (U2/UN1). */
  decision: 'send' | 'blocked';
  /** The high-confidence findings that blocked the plan (empty on `send`). */
  blockers: SecretFinding[];
  /** Set when the scanner itself failed — fail-closed, never send-on-error. */
  scanError?: string;
  /** Every input, in input order, with its decision (sent AND withheld). */
  files: EgressFileDecision[];
  /** Sum of `bytes` across included files. */
  totalBytes: number;
  /** Medium-severity scan notes (private IPs, emails) — warn, never block. */
  warnings: string[];
}

/** UTF-8 byte length without Buffer (entities stay engine-portable). */
function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/**
 * Builds the egress plan for one assist call: classify every input
 * (default-deny), apply `--assist-include`/opt-in widening, scan everything
 * that would leave, redact allowed rules, and block on the rest.
 *
 * Fail-closed (UN1): any scanner throw yields `decision: 'blocked'` with
 * `scanError` set — never send-on-error. Inputs whose class keeps them out
 * are still listed (included: false) so the disclosure can show what was
 * withheld and why.
 */
export function planEgress(
  inputs: readonly EgressFileInput[],
  flags: EgressFlags,
  scanOptions?: SecretScanOptions,
): EgressPlan {
  const files: EgressFileDecision[] = [];
  const blockers: SecretFinding[] = [];
  const warnings: string[] = [];
  const allowed = new Set(flags.allowSecretRules);
  let totalBytes = 0;

  for (const input of inputs) {
    const cls = classifyEgress(input);
    const matchedInclude = flags.include.some((pattern) => matchesGlob(pattern, input.path));
    const optedIn = cls === 'opt-in' && flags.optInPaths.includes(input.path);
    // The binary/non-UTF-8 veto is ABSOLUTE: `--assist-include` is the escape
    // hatch for a denied CLASS, but it must never pull in a binary blob (the
    // veto and a class-`deny` share the 'deny' label, so check content directly).
    const binary = hasBinaryContent(input.content);
    const included = !binary && (cls === 'allow' || optedIn || matchedInclude);
    const decision: EgressFileDecision = {
      path: input.path,
      class: cls,
      included,
      viaInclude: included && cls !== 'allow' && !optedIn && matchedInclude,
      bytes: 0,
      content: '',
      findings: [],
      redactedRules: [],
    };
    if (input.slot !== undefined) {
      decision.slot = input.slot;
    }
    if (included) {
      let findings: SecretFinding[];
      try {
        findings = scanForSecrets(input.path, input.content, scanOptions);
      } catch (err) {
        // UN1 — the scanner failing means we cannot prove what would leave:
        // block the whole plan, attribute the error, send nothing.
        return {
          decision: 'blocked',
          blockers: [],
          scanError: `secret scan failed on ${input.path}: ${err instanceof Error ? err.message : String(err)}`,
          files,
          totalBytes: 0,
          warnings,
        };
      }
      decision.findings = findings;
      const toRedact: SecretFinding[] = [];
      for (const finding of findings) {
        if (finding.severity === 'high') {
          if (allowed.has(finding.ruleId)) {
            toRedact.push(finding);
            if (!decision.redactedRules.includes(finding.ruleId)) {
              decision.redactedRules.push(finding.ruleId);
            }
          } else {
            blockers.push(finding);
          }
        } else {
          warnings.push(
            `${finding.path}:${finding.line} ${finding.ruleId} (${finding.excerpt})`,
          );
        }
      }
      decision.content = toRedact.length > 0 ? redactFindings(input.content, toRedact) : input.content;
      decision.bytes = byteLength(decision.content);
      totalBytes += decision.bytes;
    }
    files.push(decision);
  }

  if (blockers.length > 0) {
    // Blocked plans zero the send payload: nothing leaves, so per-file bytes
    // and contents are cleared to keep the plan unambiguous about that.
    for (const file of files) {
      file.included = false;
      file.bytes = 0;
      file.content = '';
    }
    return { decision: 'blocked', blockers, files, totalBytes: 0, warnings };
  }
  return { decision: 'send', blockers: [], files, totalBytes, warnings };
}

/**
 * OPT1 (regulated default-off): `init.assist.endpointPolicy: "approved-only"`
 * refuses any provider/endpoint not on the configured allowlist — the
 * recommended posture for corporate installs per the threat model's channel
 * guidance. `'any'` (the default) imposes no restriction here; the per-run
 * consent gate still applies.
 */
export interface EndpointPolicy {
  policy: 'any' | 'approved-only';
  /** Approved provider ids (or endpoint labels) when `approved-only`. */
  approved: readonly string[];
}

export function checkEndpointPolicy(
  endpointPolicy: EndpointPolicy,
  provider: string,
): { allowed: boolean; reason?: string } {
  if (endpointPolicy.policy === 'any') {
    return { allowed: true };
  }
  if (endpointPolicy.approved.includes(provider)) {
    return { allowed: true };
  }
  return {
    allowed: false,
    reason:
      `provider "${provider}" is not on the approved-endpoint allowlist ` +
      `(init.assist.endpointPolicy is "approved-only"; approved: ` +
      `${endpointPolicy.approved.length > 0 ? endpointPolicy.approved.join(', ') : '(none)'})`,
  };
}
