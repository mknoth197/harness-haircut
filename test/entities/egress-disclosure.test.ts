/**
 * Egress disclosure renderer — UNIT tests (testing.md category 1: pure, no
 * I/O, single file under test: `src/entities/egress-disclosure.ts`).
 *
 * Spec: docs/stories/14-C5-assist-egress-redaction.md (EV1/EV2/EV4/EV5, U1/U2,
 * UN1/UN2) and the consent/disclosure section of
 * docs/security/assist-egress-threat-model.md. Plans are built through the
 * real `planEgress()` so rendered lines reflect genuine policy decisions;
 * the de-dupe test hand-constructs a plan to force duplicate blockers.
 *
 * Every "secret" in this file is SYNTHETIC — constructed at runtime by
 * concatenation/repetition so secret scanners never flag this repo. None of
 * these strings is, or ever was, a real credential.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  renderEgressDisclosure,
  renderEgressPreview,
  renderEgressBlock,
  EGRESS_CONSENT_PROMPT,
  planEgress,
  defaultEgressFlags,
} from '../../dist/index.js';
import type { EgressDestination, EgressPlan, SecretFinding } from '../../dist/index.js';

/** Synthetic AWS access key id: AKIA + 16 uppercase chars (never a real credential). */
const AWS_KEY = 'AKIA' + 'A'.repeat(16);
/** Synthetic GitHub token: ghp_ + 36 alphanumerics (never a real credential). */
const GITHUB_TOKEN = 'ghp_' + 'a'.repeat(36);

/** Regex-escape a literal so `assert.match` can assert on exact substrings. */
function containing(literal: string): RegExp {
  return new RegExp(literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
}

/** Anchored single-line match — proves the line carries no extra markers. */
function asLine(literal: string): RegExp {
  return new RegExp(`^${literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'm');
}

function destination(overrides: Partial<EgressDestination> = {}): EgressDestination {
  return {
    provider: 'anthropic',
    model: 'claude-sonnet-4-5',
    sourceKind: 'api-key',
    retentionCaveat: 'inputs may be retained up to 30 days per vendor policy',
    ...overrides,
  };
}

/** A minimal clean plan: one allowed prose file, nothing withheld. */
function cleanPlan(): EgressPlan {
  return planEgress([{ path: 'AGENTS.md', content: 'hello\n' }], defaultEgressFlags());
}

/**
 * Mixed plan for the EV4 file-list rules: two allowed prose files (one with a
 * multi-byte char so byte counts are provably bytes, not chars), one
 * hard-denied hook script, one un-approved opt-in skill body.
 */
function fileListPlan(): EgressPlan {
  return planEgress(
    [
      { path: 'AGENTS.md', content: 'hello\n' }, // 6 B
      { path: '.agents/instructions/testing.md', content: 'café rules\n' }, // 11 chars, 12 B
      { path: '.agents/hooks/deploy.sh', content: '#!/bin/sh\n' },
      { path: '.agents/skills/demo/SKILL.md', content: '# demo skill\n' },
    ],
    defaultEgressFlags(),
  );
}

/** Blocked plan: synthetic high-confidence secrets in two allowed files (U2). */
function blockedPlan(): EgressPlan {
  return planEgress(
    [
      { path: 'AGENTS.md', content: `# Title\n\nkey ${AWS_KEY}\n` },
      { path: 'docs/AGENTS.md', content: `${GITHUB_TOKEN}\n` },
    ],
    defaultEgressFlags(),
  );
}

describe('renderEgressDisclosure()', () => {
  it('names the destination provider, credential-source kind, and resolved model (EV4)', () => {
    const out = renderEgressDisclosure(cleanPlan(), destination());
    assert.match(out, asLine('destination: anthropic (api-key) — model claude-sonnet-4-5'));
  });

  it('always prints the vendor retention/training caveat (EV4)', () => {
    const out = renderEgressDisclosure(cleanPlan(), destination());
    assert.match(out, asLine('retention: inputs may be retained up to 30 days per vendor policy'));
  });

  it('prints the ToS caveat line when the chosen source carries one (EV5)', () => {
    const out = renderEgressDisclosure(
      cleanPlan(),
      destination({
        sourceKind: 'subscription-session',
        model: '(CLI default)',
        tosCaveat: 'consumer subscription sessions may prohibit automated use',
      }),
    );
    assert.match(out, asLine('destination: anthropic (subscription-session) — model (CLI default)'));
    assert.match(out, asLine('caveat: consumer subscription sessions may prohibit automated use'));
  });

  it('omits the caveat line entirely when no ToS caveat applies (EV5)', () => {
    const out = renderEgressDisclosure(cleanPlan(), destination());
    assert.doesNotMatch(out, /^caveat:/m);
  });

  it('lists every included file with its exact per-file UTF-8 byte count (EV4)', () => {
    const out = renderEgressDisclosure(fileListPlan(), destination());
    assert.match(out, asLine('  + AGENTS.md  6 B'));
    // 'café rules\n' is 11 characters but 12 UTF-8 bytes — the count is bytes.
    assert.match(out, asLine('  + .agents/instructions/testing.md  12 B'));
  });

  it('labels each withheld file with its class instead of sending it (EV4/U1)', () => {
    const out = renderEgressDisclosure(fileListPlan(), destination());
    assert.match(out, asLine('  - .agents/hooks/deploy.sh  withheld [deny]'));
    assert.match(out, asLine('  - .agents/skills/demo/SKILL.md  withheld [opt-in]'));
  });

  it('prints the sent/withheld header and a total line with summed bytes and file count (EV4)', () => {
    const out = renderEgressDisclosure(fileListPlan(), destination());
    assert.match(out, asLine('files (2 to send, 2 withheld):'));
    assert.match(out, asLine('total: 18 B in 2 file(s)')); // 6 B + 12 B across the 2 sent files
  });

  it('marks a hard-denied file pulled in by --assist-include with a via marker (EV1)', () => {
    const hook = '#!/bin/sh\necho deploy\n';
    const plan = planEgress([{ path: '.agents/hooks/deploy.sh', content: hook }], {
      include: ['.agents/hooks/**'],
      optInPaths: [],
      allowSecretRules: [],
    });
    const bytes = new TextEncoder().encode(hook).length;
    const out = renderEgressDisclosure(plan, destination());
    assert.match(
      out,
      asLine(`  + .agents/hooks/deploy.sh  ${bytes} B [deny — via --assist-include]`),
    );
  });

  it('marks an interactively approved opt-in file as user approved (EV1)', () => {
    const skill = '# demo skill\n';
    const path = '.agents/skills/demo/SKILL.md';
    const plan = planEgress([{ path, content: skill }], {
      include: [],
      optInPaths: [path],
      allowSecretRules: [],
    });
    const bytes = new TextEncoder().encode(skill).length;
    const out = renderEgressDisclosure(plan, destination());
    assert.match(out, asLine(`  + ${path}  ${bytes} B [opt-in — user approved]`));
  });

  it('summarizes redactions naming the rule and the file it fired in (EV2)', () => {
    const plan = planEgress([{ path: 'AGENTS.md', content: `setup ${AWS_KEY} done\n` }], {
      include: [],
      optInPaths: [],
      allowSecretRules: ['aws-access-key-id'],
    });
    assert.equal(plan.decision, 'send');
    const out = renderEgressDisclosure(plan, destination());
    assert.match(
      out,
      asLine('secret scan: 1 redaction(s) — AGENTS.md: [REDACTED:aws-access-key-id]'),
    );
    assert.match(out, containing('(redacted: aws-access-key-id)'));
  });

  it('prints medium-severity scan findings as warnings that never block (U2)', () => {
    const plan = planEgress(
      [{ path: 'AGENTS.md', content: 'host 192.168.1.50 internal\n' }],
      defaultEgressFlags(),
    );
    assert.equal(plan.decision, 'send');
    const out = renderEgressDisclosure(plan, destination());
    assert.match(out, asLine('  warning: AGENTS.md:1 rfc1918-ip (192.…)'));
  });

  it('reports a clean secret scan when nothing matched (EV4)', () => {
    const out = renderEgressDisclosure(cleanPlan(), destination());
    assert.match(out, asLine('secret scan: clean'));
  });

  it('never prints file body content — the body belongs only to the preview (UN2)', () => {
    const body = 'unmistakable-body-sentinel line\n';
    const plan = planEgress([{ path: 'AGENTS.md', content: body }], defaultEgressFlags());
    const out = renderEgressDisclosure(plan, destination());
    assert.doesNotMatch(out, containing('unmistakable-body-sentinel'));
  });
});

describe('renderEgressPreview()', () => {
  it('prints the exact post-redaction bytes of each included file, byte for byte (EV4)', () => {
    const body = 'unmistakable-body-sentinel line one\nline two\n';
    const plan = planEgress(
      [
        { path: 'AGENTS.md', content: body },
        { path: '.agents/hooks/deploy.sh', content: 'hook-body-never-shown\n' },
      ],
      defaultEgressFlags(),
    );
    const bytes = new TextEncoder().encode(body).length;
    assert.equal(
      renderEgressPreview(plan),
      '--- post-redaction preview (exact bytes to send) ---\n' +
        `==> AGENTS.md (${bytes} B)\n` +
        body +
        '\n--- end preview ---\n',
    );
  });

  it('shows the stable [REDACTED:<rule>] placeholder in place of an allowed secret (EV2)', () => {
    const plan = planEgress([{ path: 'AGENTS.md', content: `key ${AWS_KEY} end\n` }], {
      include: [],
      optInPaths: [],
      allowSecretRules: ['aws-access-key-id'],
    });
    const out = renderEgressPreview(plan);
    assert.match(out, containing('key [REDACTED:aws-access-key-id] end\n'));
    assert.doesNotMatch(out, containing(AWS_KEY));
  });

  it('omits withheld files entirely — neither path nor body appears (EV4/U1)', () => {
    const plan = planEgress(
      [
        { path: 'AGENTS.md', content: 'kept\n' },
        { path: '.agents/hooks/deploy.sh', content: 'hook-body-never-shown\n' },
      ],
      defaultEgressFlags(),
    );
    const out = renderEgressPreview(plan);
    assert.doesNotMatch(out, containing('.agents/hooks/deploy.sh'));
    assert.doesNotMatch(out, containing('hook-body-never-shown'));
  });
});

describe('renderEgressBlock()', () => {
  it('names every blocking finding as path:line rule with the masked excerpt (U2)', () => {
    const out = renderEgressBlock(blockedPlan());
    assert.match(out, containing('assist egress blocked: 2 high-confidence secret match(es)'));
    assert.match(out, asLine('  AGENTS.md:3 aws-access-key-id (AKIA…)'));
    assert.match(out, asLine('  docs/AGENTS.md:1 github-token (ghp_…)'));
  });

  it('never echoes the full matched secret — the excerpt stays masked (U2)', () => {
    const out = renderEgressBlock(blockedPlan());
    assert.doesNotMatch(out, containing(AWS_KEY));
    assert.doesNotMatch(out, containing(GITHUB_TOKEN));
  });

  it('lists both remedies: --assist-allow-secret redaction or running without --assist (U2/EV2)', () => {
    const out = renderEgressBlock(blockedPlan());
    assert.match(out, containing('Nothing was sent.'));
    assert.match(out, containing('re-run with --assist-allow-secret <rule>'));
    assert.match(out, containing('replaced by [REDACTED:<rule>]'));
    assert.match(out, containing('run without --assist'));
  });

  it('prints each duplicated blocker once (stable de-dupe by path:line:rule)', () => {
    const finding: SecretFinding = {
      ruleId: 'aws-access-key-id',
      severity: 'high',
      path: 'AGENTS.md',
      line: 3,
      start: 13,
      end: 33,
      excerpt: 'AKIA…',
    };
    const plan: EgressPlan = {
      decision: 'blocked',
      blockers: [finding, { ...finding }],
      files: [],
      totalBytes: 0,
      warnings: [],
    };
    const out = renderEgressBlock(plan);
    assert.equal(out.split('AGENTS.md:3 aws-access-key-id').length - 1, 1);
  });

  it('renders the fail-closed message when the secret scan itself errored (UN1)', () => {
    // An invalid extra-rule regex makes scanForSecrets throw; planEgress must
    // fail closed (never send-on-error) and the block message must say so.
    const plan = planEgress([{ path: 'AGENTS.md', content: 'plain prose\n' }], defaultEgressFlags(), {
      extraRules: [{ id: 'broken-rule', description: 'invalid regex', severity: 'high', pattern: '(' }],
    });
    assert.equal(plan.decision, 'blocked');
    const out = renderEgressBlock(plan);
    assert.match(out, asLine('assist egress blocked (fail-closed): the secret scan errored.'));
    assert.match(out, containing('secret scan failed on AGENTS.md'));
    assert.match(out, asLine('Nothing was sent. Re-run without --assist to proceed deterministically.'));
  });
});

describe('EGRESS_CONSENT_PROMPT', () => {
  it('requires an explicit affirmative — the prompt defaults to No (EV4)', () => {
    assert.match(EGRESS_CONSENT_PROMPT, /\[y\/N\]/);
  });
});
