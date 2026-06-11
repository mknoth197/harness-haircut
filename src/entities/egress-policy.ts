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

/** Replacement char — its presence means the source bytes were not valid UTF-8. */
const NON_UTF8_MARKER = '�';

/** Path-class rules; no match → deny (default-deny catch-all). */
function classifyByPath(path: string): EgressClass {
  // Hard denies named by the threat model come FIRST — before any allow —
  // so a hook/settings/state/backup path can never be mistaken for prose.
  // (`.harness-haircut-init-backup/CLAUDE.md` is exactly what init writes
  // when it backs up a root shim; a suffix-matched allow must not see it.)
  if (path.startsWith('.agents/hooks/')) {
    return 'deny';
  }
  if (
    path === '.claude/settings.json' ||
    path === '.codex/hooks.json' ||
    path === '.codex/config.toml' ||
    path === '.gemini/settings.json'
  ) {
    return 'deny';
  }
  if (path === '.agents/.harness-state.json' || path.startsWith('.harness-haircut-init-backup/')) {
    return 'deny';
  }
  // Instruction prose (allow): root or nested AGENTS.md / provider shims.
  if (path === 'AGENTS.md' || path.endsWith('/AGENTS.md')) {
    return 'allow';
  }
  if (path === 'CLAUDE.md' || path.endsWith('/CLAUDE.md')) {
    return 'allow';
  }
  if (path === 'GEMINI.md' || path.endsWith('/GEMINI.md')) {
    return 'allow';
  }
  if (path === '.github/copilot-instructions.md') {
    return 'allow';
  }
  // Scoped instruction fragments (allow) — `.md` only; anything else that
  // strays into these directories falls through to the deny catch-all.
  if (
    (path.startsWith('.agents/instructions/') ||
      path.startsWith('.github/instructions/') ||
      path.startsWith('.claude/rules/')) &&
    path.endsWith('.md')
  ) {
    return 'allow';
  }
  // Skill bodies (opt-in): exactly `<root>/skills/<name>/SKILL.md` across the
  // canonical and provider skill roots. Siblings/attachments under a skill
  // folder (scripts, assets, `.env`) fall through to deny — highest secret
  // density per the threat model.
  for (const root of ['.agents/skills/', '.claude/skills/', '.codex/skills/']) {
    if (path.startsWith(root) && path.endsWith('/SKILL.md')) {
      const rest = path.slice(root.length, -'/SKILL.md'.length);
      if (rest !== '' && !rest.includes('/')) {
        return 'opt-in';
      }
    }
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
 * Classification for one egress candidate. The slot (when present) decides
 * the class; the path is the fallback for slot-less files. Non-UTF-8 content
 * (replacement chars survive decoding) hard-denies regardless of either —
 * binary blobs are never instruction prose.
 */
export function classifyEgress(input: {
  path: string;
  slot?: string;
  content: string;
}): EgressClass {
  if (input.content.includes(NON_UTF8_MARKER)) {
    return 'deny';
  }
  return input.slot !== undefined ? classifyCandidateSlot(input.slot) : classifyByPath(input.path);
}

/** Caps for `--assist-include` patterns (threat-model finding 3: bounded globs). */
const MAX_GLOB_LENGTH = 256;
const MAX_GLOB_WILDCARDS = 16;

/**
 * Minimal bounded glob for `--assist-include`: `**` crosses segments, `*`
 * and `?` stay within one. Comparison is over repo-relative POSIX paths. A
 * pattern over the length/wildcard caps matches NOTHING (fail-closed: a
 * hostile or runaway pattern cannot widen egress, only fail to).
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
  let re = '^';
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i]!;
    if (ch === '*') {
      if (pattern[i + 1] === '*') {
        // `**/` (or trailing `**`) — any number of whole segments.
        re += pattern[i + 2] === '/' ? '(?:[^/]+/)*' : '.*';
        i += pattern[i + 2] === '/' ? 2 : 1;
      } else {
        re += '[^/]*';
      }
    } else if (ch === '?') {
      re += '[^/]';
    } else {
      re += /[A-Za-z0-9_]/.test(ch) ? ch : `\\${ch}`;
    }
  }
  re += '$';
  return new RegExp(re).test(path);
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
    const included = cls === 'allow' || optedIn || matchedInclude;
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
