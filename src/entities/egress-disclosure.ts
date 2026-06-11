/**
 * Egress consent/disclosure renderer for `init --assist` — C5 (#30)
 * EV4/UN2, layer 1 (entities): pure text rendering over an `EgressPlan`,
 * no I/O.
 *
 * Before ANY byte leaves the machine the CLI prints this disclosure and
 * requires an explicit affirmative. The renderer is split so the
 * NON-SUPPRESSIBLE part (destination + exact file list with per-file and
 * total byte counts + retention caveat + secret-scan summary) is one
 * function, and the body preview (the exact post-redaction bytes) is
 * default-ON but separately suppressible via `--no-preview` (UN2: even with
 * `--no-preview` + `--assist-yes`/remembered consent, the list/counts/
 * summary still print for auditability — only the body is elided).
 */
import type { EgressPlan, EgressFileDecision } from './egress-policy.js';
import type { SecretFinding } from './secret-scan.js';

/** Where the bytes would go — shown verbatim in the disclosure (EV3/EV5). */
export interface EgressDestination {
  /** Provider id, e.g. `anthropic` / `openai` / `google` / `github-copilot`. */
  provider: string;
  /** Resolved model id, or a label like `(CLI default)` for session backends. */
  model: string;
  /** Credential-source kind the user chose. */
  sourceKind: 'api-key' | 'subscription-session';
  /** Vendor retention/training caveat — always printed (threat model). */
  retentionCaveat: string;
  /** ToS/feasibility caveat for the chosen source (EV5), when one applies. */
  tosCaveat?: string;
}

export interface DisclosureOptions {
  /** EV4 default-ON body preview; `--no-preview` sets this false (UN2). */
  preview: boolean;
}

function fileLine(file: EgressFileDecision): string {
  if (file.included) {
    const via = file.viaInclude
      ? ` [${file.class} — via --assist-include]`
      : file.class === 'opt-in'
        ? ' [opt-in — user approved]'
        : '';
    const redacted =
      file.redactedRules.length > 0 ? ` (redacted: ${file.redactedRules.join(', ')})` : '';
    return `  + ${file.path}  ${file.bytes} B${via}${redacted}`;
  }
  return `  - ${file.path}  withheld [${file.class}]`;
}

function secretSummary(plan: EgressPlan): string[] {
  const lines: string[] = [];
  const redactions = plan.files.flatMap((file) =>
    file.redactedRules.map((rule) => `${file.path}: [REDACTED:${rule}]`),
  );
  if (redactions.length === 0 && plan.warnings.length === 0) {
    lines.push('secret scan: clean');
    return lines;
  }
  if (redactions.length > 0) {
    lines.push(`secret scan: ${redactions.length} redaction(s) — ${redactions.join('; ')}`);
  } else {
    lines.push(`secret scan: ${plan.warnings.length} warning(s)`);
  }
  for (const warning of plan.warnings) {
    lines.push(`  warning: ${warning}`);
  }
  return lines;
}

/**
 * The non-suppressible disclosure (EV4): destination + credential kind +
 * resolved model, the EXACT file list with per-file and total byte counts
 * (sent and withheld), the vendor retention caveat, the ToS caveat for the
 * chosen source (EV5), and the secret-scan summary. Every `--assist-include`
 * pull-in is individually visible via its file line (EV1).
 */
export function renderEgressDisclosure(plan: EgressPlan, destination: EgressDestination): string {
  const lines: string[] = [];
  lines.push('--- AI-assist egress disclosure ---');
  lines.push(
    `destination: ${destination.provider} (${destination.sourceKind}) — model ${destination.model}`,
  );
  lines.push(`retention: ${destination.retentionCaveat}`);
  if (destination.tosCaveat !== undefined) {
    lines.push(`caveat: ${destination.tosCaveat}`);
  }
  const sent = plan.files.filter((file) => file.included);
  const withheld = plan.files.filter((file) => !file.included);
  lines.push(`files (${sent.length} to send, ${withheld.length} withheld):`);
  for (const file of plan.files) {
    lines.push(fileLine(file));
  }
  lines.push(`total: ${plan.totalBytes} B in ${sent.length} file(s)`);
  for (const line of secretSummary(plan)) {
    lines.push(line);
  }
  return `${lines.join('\n')}\n`;
}

/**
 * The default-ON body preview (EV4): the EXACT post-redaction bytes that
 * would be sent, per file. Byte-accurate by construction — it prints
 * `EgressFileDecision.content`, which is precisely what the backend would
 * transmit. Suppressed (whole section) by `--no-preview`; the caller must
 * still have printed `renderEgressDisclosure` (UN2).
 */
export function renderEgressPreview(plan: EgressPlan): string {
  const lines: string[] = [];
  lines.push('--- post-redaction preview (exact bytes to send) ---');
  for (const file of plan.files) {
    if (!file.included) {
      continue;
    }
    lines.push(`==> ${file.path} (${file.bytes} B)`);
    lines.push(file.content);
  }
  lines.push('--- end preview ---');
  return `${lines.join('\n')}\n`;
}

/**
 * U2 hard-block message: names every blocking finding as file + line + rule
 * (with the masked excerpt — never the secret itself) and the two remedies
 * (allow-with-redaction per rule, or run without --assist). Also renders the
 * UN1 fail-closed scanner-error block.
 */
export function renderEgressBlock(plan: EgressPlan): string {
  const lines: string[] = [];
  if (plan.scanError !== undefined) {
    lines.push('assist egress blocked (fail-closed): the secret scan errored.');
    lines.push(`  ${plan.scanError}`);
    lines.push('Nothing was sent. Re-run without --assist to proceed deterministically.');
    return `${lines.join('\n')}\n`;
  }
  const blockers = dedupeBlockers(plan.blockers);
  lines.push(
    `assist egress blocked: ${blockers.length} high-confidence secret match(es) ` +
      'in content that would have been sent.',
  );
  for (const finding of blockers) {
    lines.push(`  ${finding.path}:${finding.line} ${finding.ruleId} (${finding.excerpt})`);
  }
  lines.push('Nothing was sent. Either:');
  lines.push('  - remove the secret(s) from the file(s) above, or');
  lines.push(
    '  - re-run with --assist-allow-secret <rule> to send with the match(es) ' +
      'replaced by [REDACTED:<rule>], or',
  );
  lines.push('  - run without --assist to resolve contradictions deterministically.');
  return `${lines.join('\n')}\n`;
}

/** Stable de-dupe for the block list (one line per path:line:rule). */
function dedupeBlockers(blockers: readonly SecretFinding[]): SecretFinding[] {
  const seen = new Set<string>();
  const out: SecretFinding[] = [];
  for (const finding of blockers) {
    const key = `${finding.path}:${finding.line}:${finding.ruleId}:${finding.start}`;
    if (!seen.has(key)) {
      seen.add(key);
      out.push(finding);
    }
  }
  return out;
}

/** The explicit-affirmative consent prompt line (EV4 — consent is opt-in). */
export const EGRESS_CONSENT_PROMPT = 'Send the listed bytes? [y/N]: ';
