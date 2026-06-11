/**
 * Unit tests for src/entities/egress-policy.ts — the C5 (#30) egress policy
 * for `init --assist`: default-deny classification by file class (U1),
 * `--assist-include` widening (EV1), secret-scan hard block (U2),
 * `--assist-allow-secret` redaction (EV2), fail-closed planning (UN1), and
 * approved-only endpoint refusal (OPT1). Pure entity layer — no I/O
 * (testing.md category 1).
 *
 * Spec: docs/stories/14-C5-assist-egress-redaction.md and the class table in
 * docs/security/assist-egress-threat-model.md.
 *
 * Every "secret" in this file is SYNTHETIC, constructed at runtime by string
 * concatenation, so secret scanners never flag this repo as holding a real
 * credential.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyEgress,
  classifyCandidateSlot,
  matchesGlob,
  planEgress,
  defaultEgressFlags,
  checkEndpointPolicy,
} from '../../dist/index.js';
import type { EgressFileDecision, EgressFlags, EgressPlan } from '../../dist/index.js';

/** Synthetic AWS access key id — shape-only, built at runtime (never real). */
const SYNTHETIC_AWS_KEY = 'AKIA' + 'A'.repeat(16);

function makeFlags(overrides: Partial<EgressFlags> = {}): EgressFlags {
  return { ...defaultEgressFlags(), ...overrides };
}

/** UTF-8 byte length, computed the same engine-portable way the module does. */
function utf8Bytes(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Looks up one path's decision in a plan, failing the test if it is absent. */
function fileFor(plan: EgressPlan, path: string): EgressFileDecision {
  const file = plan.files.find((f) => f.path === path);
  if (file === undefined) {
    assert.fail(`expected plan.files to list ${path}`);
  }
  return file;
}

/** First element of a list the test requires to be non-empty. */
function first<T>(items: readonly T[], what: string): T {
  const item = items[0];
  if (item === undefined) {
    assert.fail(`expected at least one ${what}`);
  }
  return item;
}

describe('classifyEgress — U1 default-deny matrix (threat-model class table)', () => {
  // ALLOW row: instruction prose is the only thing the merge reasons about.
  // AGENTS.md is allowed root+nested; CLAUDE.md/GEMINI.md are root shims, so
  // they allow only at the repo root (a nested CLAUDE.md is not a thing this
  // tool emits and must not be trusted as prose by path — see denyPaths).
  const allowPaths = [
    'AGENTS.md',
    'pkg/sub/AGENTS.md',
    'CLAUDE.md',
    'GEMINI.md',
    '.github/copilot-instructions.md',
    '.agents/instructions/testing.md',
    '.github/instructions/x.instructions.md',
    '.claude/rules/style.md',
  ];
  for (const path of allowPaths) {
    it(`classifies instruction prose ${path} as allow by default`, () => {
      assert.equal(classifyEgress({ path, content: '# prose\n' }), 'allow');
    });
  }

  // OPT-IN row: skill bodies embed example calls / internal URLs.
  const optInPaths = [
    '.agents/skills/foo/SKILL.md',
    '.claude/skills/foo/SKILL.md',
    '.codex/skills/foo/SKILL.md',
  ];
  for (const path of optInPaths) {
    it(`classifies skill body ${path} as opt-in`, () => {
      assert.equal(classifyEgress({ path, content: '# skill\n' }), 'opt-in');
    });
  }

  // HARD-DENY rows: hooks, settings/hook JSON, skill siblings, tool state,
  // and the unknown-path catch-all. The prose-named entries are C5-review
  // regressions: a deny-class directory must beat a prose basename, so a
  // skill sibling / nested backup / nested hook named like a shim still denies.
  const denyPaths = [
    '.agents/hooks/deploy.sh',
    '.claude/settings.json',
    '.codex/hooks.json',
    '.codex/config.toml',
    '.gemini/settings.json',
    '.agents/.harness-state.json',
    '.agents/skills/foo/run.sh',
    '.agents/skills/foo/.env',
    '.agents/skills/a/b/SKILL.md',
    '.agents/instructions/helper.sh',
    'README.md',
    // nested CLAUDE.md/GEMINI.md are not root shims → not prose-by-path.
    'docs/CLAUDE.md',
    'pkg/GEMINI.md',
    // prose-named skill SIBLINGS (highest secret density) must still deny.
    '.agents/skills/deployer/CLAUDE.md',
    '.claude/skills/deployer/AGENTS.md',
    '.codex/skills/deployer/GEMINI.md',
    // hook scripts named like prose, and hook dirs at any provider root.
    '.agents/hooks/AGENTS.md',
    '.github/hooks/CLAUDE.md',
    // backups at nested depth (top-level-only prefix used to miss these).
    'old/.harness-haircut-init-backup/CLAUDE.md',
    '.harness-haircut-init-backup/AGENTS.md',
  ];
  for (const path of denyPaths) {
    it(`classifies ${path} as deny by default`, () => {
      assert.equal(classifyEgress({ path, content: 'x\n' }), 'deny');
    });
  }

  it('allows a backup-LOOKALIKE dir only because its CLAUDE.md basename is not root (catch-all deny)', () => {
    // `…-init-backup-not/` is NOT the exact backup segment, but a nested
    // CLAUDE.md is denied anyway by the catch-all — proving the lookalike
    // cannot smuggle prose through the suffix match.
    assert.equal(
      classifyEgress({ path: 'evil/.harness-haircut-init-backup-not/CLAUDE.md', content: '# x\n' }),
      'deny',
    );
  });

  it('denies content carrying an embedded NUL byte even at an allowed path', () => {
    assert.equal(classifyEgress({ path: 'AGENTS.md', content: 'pre\u0000post' }), 'deny');
  });

  it('classifies a backup-dir file with a non-shim name as deny', () => {
    assert.equal(
      classifyEgress({ path: '.harness-haircut-init-backup/state.json', content: '{}\n' }),
      'deny',
    );
  });

  // U1: `.harness-haircut-init-backup/**` is hard-denied (threat model:
  // "tool bookkeeping / unchosen backups"). A backed-up root shim keeps its
  // prose-looking basename (`…-init-backup/CLAUDE.md`), so the deny rules
  // must run before the suffix-matched prose allows.
  it('classifies .harness-haircut-init-backup/CLAUDE.md as deny (U1 backups are hard-denied)', () => {
    assert.equal(
      classifyEgress({ path: '.harness-haircut-init-backup/CLAUDE.md', content: '# x\n' }),
      'deny',
    );
  });

  it('denies non-UTF-8 content (replacement char present) even at an allowed path', () => {
    assert.equal(classifyEgress({ path: 'AGENTS.md', content: 'pre�post' }), 'deny');
    // The binary catch-all also beats an allow-class slot.
    assert.equal(
      classifyEgress({ path: 'AGENTS.md', slot: 'root-instructions', content: 'pre�post' }),
      'deny',
    );
  });
});

describe('classifyCandidateSlot — resolver candidates classify by slot (U1)', () => {
  it("classifies the 'root-instructions' slot as allow (prose)", () => {
    assert.equal(classifyCandidateSlot('root-instructions'), 'allow');
  });

  it("classifies a 'fragment:x' slot as allow (prose)", () => {
    assert.equal(classifyCandidateSlot('fragment:x'), 'allow');
  });

  it("classifies a 'skill:x' slot as opt-in (SKILL.md body)", () => {
    assert.equal(classifyCandidateSlot('skill:x'), 'opt-in');
  });

  it('classifies an unknown slot kind as deny (fail-closed namespace)', () => {
    assert.equal(classifyCandidateSlot('something-else'), 'deny');
  });

  it('combines slot and path as the MORE RESTRICTIVE class (a slot may only narrow, never widen)', () => {
    // C5-review fix: a hard-denied PATH vetoes any benign slot — a denied
    // settings.json carried under a root-instructions slot stays denied, so
    // C4 can never widen egress by mispairing a slot with a denied path.
    assert.equal(
      classifyEgress({ path: '.claude/settings.json', slot: 'root-instructions', content: '{}\n' }),
      'deny',
    );
    assert.equal(
      classifyEgress({ path: '.agents/hooks/deploy.sh', slot: 'fragment:x', content: '#!/bin/sh\n' }),
      'deny',
    );
    // A slot narrows an allow-class path: AGENTS.md under a skill slot → opt-in.
    assert.equal(
      classifyEgress({ path: 'AGENTS.md', slot: 'skill:demo', content: '# x\n' }),
      'opt-in',
    );
    // A skill body keeps its opt-in even if mislabeled with a prose slot
    // (the path is opt-in, the slot allow → strictest is opt-in, never allow).
    assert.equal(
      classifyEgress({
        path: '.agents/skills/foo/SKILL.md',
        slot: 'root-instructions',
        content: '# x\n',
      }),
      'opt-in',
    );
    // The legitimate candidate path: a root shim recovered as root-instructions
    // stays allow (path allow, slot allow).
    assert.equal(
      classifyEgress({ path: 'CLAUDE.md', slot: 'root-instructions', content: '# x\n' }),
      'allow',
    );
  });
});

describe('matchesGlob — bounded --assist-include matching (EV1, fail-closed caps)', () => {
  it('matches a literal pattern exactly and nothing else', () => {
    assert.equal(matchesGlob('.claude/settings.json', '.claude/settings.json'), true);
    assert.equal(matchesGlob('.claude/settings.json', '.claude/settings.jsonx'), false);
  });

  it("keeps '*' within one path segment (never crosses '/')", () => {
    assert.equal(matchesGlob('.agents/hooks/*.sh', '.agents/hooks/deploy.sh'), true);
    assert.equal(matchesGlob('.agents/*.sh', '.agents/hooks/deploy.sh'), false);
  });

  it("lets '**' cross path segments", () => {
    assert.equal(matchesGlob('.agents/**', '.agents/hooks/deploy.sh'), true);
    assert.equal(matchesGlob('.agents/**/SKILL.md', '.agents/skills/foo/SKILL.md'), true);
  });

  it("matches exactly one non-'/' character with '?'", () => {
    assert.equal(matchesGlob('doc?.md', 'docs.md'), true);
    assert.equal(matchesGlob('doc?.md', 'doc.md'), false);
    assert.equal(matchesGlob('a?b', 'a/b'), false);
  });

  it('treats regex metacharacters in the pattern as literals', () => {
    assert.equal(matchesGlob('a+b.md', 'a+b.md'), true);
    // If '+' and '.' were regex-active, /^a+b.md$/ would match this too.
    assert.equal(matchesGlob('a+b.md', 'aabXmd'), false);
  });

  it('matches nothing for a pattern longer than 256 characters (fail-closed)', () => {
    const atCap = 'a'.repeat(256);
    const overCap = 'a'.repeat(257);
    assert.equal(matchesGlob(atCap, atCap), true);
    assert.equal(matchesGlob(overCap, overCap), false);
  });

  it('matches nothing for a pattern with more than 16 wildcards (fail-closed)', () => {
    assert.equal(matchesGlob('*'.repeat(16), 'anything'), true);
    assert.equal(matchesGlob('*'.repeat(17), 'anything'), false);
  });
});

describe('planEgress — default inclusion by class (U1)', () => {
  const inputs = [
    { path: 'AGENTS.md', content: '# Standards\n' },
    { path: '.agents/skills/foo/SKILL.md', content: '# skill body\n' },
    { path: '.claude/settings.json', content: '{"theme":"dark"}\n' },
  ];

  it('includes an allow-class file by default and sends its exact bytes', () => {
    const plan = planEgress(inputs, makeFlags());
    assert.equal(plan.decision, 'send');
    const prose = fileFor(plan, 'AGENTS.md');
    assert.equal(prose.class, 'allow');
    assert.equal(prose.included, true);
    assert.equal(prose.viaInclude, false);
    assert.equal(prose.content, '# Standards\n');
    assert.equal(prose.bytes, utf8Bytes('# Standards\n'));
  });

  it('lists opt-in and deny files as withheld: included false, bytes 0, content empty', () => {
    const plan = planEgress(inputs, makeFlags());
    for (const path of ['.agents/skills/foo/SKILL.md', '.claude/settings.json']) {
      const withheld = fileFor(plan, path);
      assert.equal(withheld.included, false);
      assert.equal(withheld.bytes, 0);
      assert.equal(withheld.content, '');
    }
    assert.equal(fileFor(plan, '.agents/skills/foo/SKILL.md').class, 'opt-in');
    assert.equal(fileFor(plan, '.claude/settings.json').class, 'deny');
  });

  it('lists every input in input order so the disclosure shows what was withheld', () => {
    const plan = planEgress(inputs, makeFlags());
    assert.deepEqual(
      plan.files.map((f) => f.path),
      ['AGENTS.md', '.agents/skills/foo/SKILL.md', '.claude/settings.json'],
    );
  });
});

describe('planEgress — --assist-include widening (EV1)', () => {
  const settings = { path: '.claude/settings.json', content: '{"theme":"dark"}\n' };

  it('pulls a deny-class file in via an --assist-include glob, flagged viaInclude', () => {
    const plan = planEgress([settings], makeFlags({ include: ['.claude/**'] }));
    assert.equal(plan.decision, 'send');
    const file = fileFor(plan, '.claude/settings.json');
    assert.equal(file.class, 'deny');
    assert.equal(file.included, true);
    assert.equal(file.viaInclude, true);
    assert.equal(file.content, '{"theme":"dark"}\n');
    assert.equal(file.bytes, utf8Bytes('{"theme":"dark"}\n'));
  });

  it('keeps the same deny-class file withheld when no include glob is passed', () => {
    const plan = planEgress([settings], makeFlags());
    const file = fileFor(plan, '.claude/settings.json');
    assert.equal(file.included, false);
    assert.equal(file.viaInclude, false);
    assert.equal(file.bytes, 0);
    assert.equal(file.content, '');
  });
});

describe('planEgress — interactive opt-in via optInPaths', () => {
  it('includes an opt-in-class file named in optInPaths, not marked viaInclude', () => {
    const plan = planEgress(
      [{ path: '.agents/skills/foo/SKILL.md', content: '# skill body\n' }],
      makeFlags({ optInPaths: ['.agents/skills/foo/SKILL.md'] }),
    );
    const file = fileFor(plan, '.agents/skills/foo/SKILL.md');
    assert.equal(file.class, 'opt-in');
    assert.equal(file.included, true);
    assert.equal(file.viaInclude, false);
    assert.equal(file.bytes, utf8Bytes('# skill body\n'));
  });

  it('does not let optInPaths include a deny-class file (only --assist-include can)', () => {
    const plan = planEgress(
      [{ path: '.claude/settings.json', content: '{}\n' }],
      makeFlags({ optInPaths: ['.claude/settings.json'] }),
    );
    const file = fileFor(plan, '.claude/settings.json');
    assert.equal(file.included, false);
    assert.equal(file.bytes, 0);
    assert.equal(file.content, '');
  });
});

describe('planEgress — secret scan hard block (U2)', () => {
  it('blocks the run when an included file holds a high-confidence secret, naming file/line/rule', () => {
    const plan = planEgress(
      [
        { path: 'AGENTS.md', content: '# clean prose\n' },
        { path: 'docs/AGENTS.md', content: `# notes\n${SYNTHETIC_AWS_KEY}\n` },
      ],
      makeFlags(),
    );
    assert.equal(plan.decision, 'blocked');
    const blocker = first(plan.blockers, 'blocker');
    assert.equal(blocker.ruleId, 'aws-access-key-id');
    assert.equal(blocker.path, 'docs/AGENTS.md');
    assert.equal(blocker.line, 2);
  });

  it('sends nothing on a blocked plan: every file ends included false with bytes 0', () => {
    const plan = planEgress(
      [
        { path: 'AGENTS.md', content: '# clean prose\n' },
        { path: 'docs/AGENTS.md', content: `# notes\n${SYNTHETIC_AWS_KEY}\n` },
      ],
      makeFlags(),
    );
    assert.equal(plan.decision, 'blocked');
    for (const file of plan.files) {
      assert.equal(file.included, false);
      assert.equal(file.bytes, 0);
      assert.equal(file.content, '');
    }
    assert.equal(plan.totalBytes, 0);
  });

  it('does not block on a secret inside a withheld file (it is never scanned for egress)', () => {
    const plan = planEgress(
      [
        { path: 'AGENTS.md', content: '# clean prose\n' },
        { path: '.claude/settings.json', content: `{"aws":"${SYNTHETIC_AWS_KEY}"}\n` },
      ],
      makeFlags(),
    );
    assert.equal(plan.decision, 'send');
    assert.deepEqual(plan.blockers, []);
    assert.deepEqual(fileFor(plan, '.claude/settings.json').findings, []);
    assert.equal(plan.totalBytes, utf8Bytes('# clean prose\n'));
  });
});

describe('planEgress — --assist-allow-secret redaction (EV2)', () => {
  // 'café' carries a multibyte char so byte length and string length differ —
  // proving `bytes` is UTF-8 byte-accurate, not a char count.
  const content = `café\n${SYNTHETIC_AWS_KEY}\n`;
  const input = { path: 'AGENTS.md', content };
  const flags = makeFlags({ allowSecretRules: ['aws-access-key-id'] });

  it('downgrades the allowed rule from block to a stable [REDACTED:<rule>] placeholder', () => {
    const plan = planEgress([input], flags);
    assert.equal(plan.decision, 'send');
    const file = fileFor(plan, 'AGENTS.md');
    assert.equal(file.content, 'café\n[REDACTED:aws-access-key-id]\n');
    assert.equal(file.content.includes(SYNTHETIC_AWS_KEY), false);
    assert.deepEqual(file.redactedRules, ['aws-access-key-id']);
    assert.equal(first(file.findings, 'finding').ruleId, 'aws-access-key-id');
  });

  it('reports bytes as the UTF-8 byte length of the POST-redaction content', () => {
    const plan = planEgress([input], flags);
    const file = fileFor(plan, 'AGENTS.md');
    assert.equal(file.bytes, utf8Bytes(file.content));
    // 'é' is 2 bytes / 1 char: byte-accurate means bytes !== content.length.
    assert.notEqual(file.bytes, file.content.length);
    assert.equal(plan.totalBytes, file.bytes);
  });
});

describe('planEgress — medium findings warn, never block', () => {
  it('surfaces a medium finding as a warning while the decision stays send', () => {
    // 'dev@example.com' is a synthetic example address (medium email rule).
    const plan = planEgress(
      [{ path: 'AGENTS.md', content: 'contact: dev@example.com\n' }],
      makeFlags(),
    );
    assert.equal(plan.decision, 'send');
    assert.deepEqual(plan.blockers, []);
    assert.equal(plan.warnings.length, 1);
    assert.match(first(plan.warnings, 'warning'), /^AGENTS\.md:1 email-address /);
    const file = fileFor(plan, 'AGENTS.md');
    assert.equal(file.included, true);
    assert.equal(file.content, 'contact: dev@example.com\n');
  });
});

describe('planEgress — fail-closed on scanner error (UN1)', () => {
  it('blocks with scanError and totalBytes 0 when an extra rule has an invalid regex', () => {
    const plan = planEgress(
      [{ path: 'AGENTS.md', content: '# clean prose\n' }],
      makeFlags(),
      { extraRules: [{ id: 'broken-rule', description: 'bad', severity: 'high', pattern: '(' }] },
    );
    assert.equal(plan.decision, 'blocked');
    assert.match(plan.scanError ?? '', /secret scan failed on AGENTS\.md/);
    assert.equal(plan.totalBytes, 0);
    assert.deepEqual(plan.blockers, []);
  });
});

describe('planEgress — totalBytes', () => {
  it('sums the bytes of included files only', () => {
    const plan = planEgress(
      [
        { path: 'AGENTS.md', content: 'aé\n' },
        { path: 'docs/AGENTS.md', content: 'xyz\n' },
        { path: '.claude/settings.json', content: '{"withheld":true}\n' },
      ],
      makeFlags(),
    );
    assert.equal(plan.decision, 'send');
    assert.equal(plan.totalBytes, utf8Bytes('aé\n') + utf8Bytes('xyz\n'));
    assert.equal(
      plan.totalBytes,
      fileFor(plan, 'AGENTS.md').bytes + fileFor(plan, 'docs/AGENTS.md').bytes,
    );
    assert.equal(fileFor(plan, '.claude/settings.json').bytes, 0);
  });
});

describe('checkEndpointPolicy — approved-only endpoint allowlist (OPT1)', () => {
  it("allows any provider when the policy is 'any'", () => {
    assert.deepEqual(checkEndpointPolicy({ policy: 'any', approved: [] }, 'anthropic'), {
      allowed: true,
    });
  });

  it('allows a provider on the approved list under approved-only', () => {
    assert.deepEqual(
      checkEndpointPolicy({ policy: 'approved-only', approved: ['bedrock', 'vertex'] }, 'bedrock'),
      { allowed: true },
    );
  });

  it('refuses an off-list provider with a reason naming the allowlist', () => {
    const result = checkEndpointPolicy(
      { policy: 'approved-only', approved: ['bedrock', 'vertex'] },
      'consumer-cli',
    );
    assert.equal(result.allowed, false);
    assert.match(result.reason ?? '', /approved-endpoint allowlist/);
    assert.match(result.reason ?? '', /approved-only/);
    assert.match(result.reason ?? '', /bedrock, vertex/);
  });

  it('refuses every provider under approved-only with an empty allowlist', () => {
    const result = checkEndpointPolicy({ policy: 'approved-only', approved: [] }, 'anthropic');
    assert.equal(result.allowed, false);
    assert.match(result.reason ?? '', /\(none\)/);
  });
});

describe('matchesGlob — bounded-time on stacked globstars (review: ReDoS, threat-model finding 3)', () => {
  it('returns quickly (no catastrophic backtracking) on stacked **/ vs a deep non-matching path', () => {
    const pattern = '**/'.repeat(8) + 'x.md'; // 28 chars, 16 wildcards — inside both caps
    const path = 'a/'.repeat(120) + 'b'; // deep, cannot match the trailing x.md
    const start = process.hrtime.bigint();
    const result = matchesGlob(pattern, path);
    const elapsedMs = Number(process.hrtime.bigint() - start) / 1e6;
    assert.equal(result, false);
    // The old adjacent-`(?:[^/]+/)*` regex took tens of seconds here; the
    // linear matcher must stay well under a small budget.
    assert.equal(elapsedMs < 50, true, `matchesGlob took ${elapsedMs.toFixed(1)}ms (expected < 50)`);
  });

  it('still matches correctly when stacked globstars are semantically a single **', () => {
    assert.equal(matchesGlob('**/'.repeat(8) + 'x.md', 'a/b/c/x.md'), true);
    assert.equal(matchesGlob('**/x.md', 'a/b/c/x.md'), true);
  });
});

describe('classifyEgress — case-insensitive deny segments (re-verify: case-variant bypass)', () => {
  // On macOS/Windows `.agents/Skills/…` is the SAME on-disk dir as
  // `.agents/skills/…`, so a case variant must not escape the skill/hook/backup
  // deny and win a prose-suffix allow.
  const caseVariants = [
    '.agents/Skills/deployer/AGENTS.md',
    '.agents/SKILLS/deployer/CLAUDE.md',
    '.github/Hooks/CLAUDE.md',
    'old/.Harness-Haircut-Init-Backup/AGENTS.md',
  ];
  for (const path of caseVariants) {
    it(`denies case-variant deny-segment path ${path}`, () => {
      assert.equal(classifyEgress({ path, content: '# x\n' }), 'deny');
    });
  }

  it('still classifies a case-variant skill BODY as opt-in (not a regression to deny)', () => {
    assert.equal(
      classifyEgress({ path: '.agents/Skills/foo/SKILL.md', content: '# s\n' }),
      'opt-in',
    );
  });
});

describe('planEgress — binary content veto is not overridable by --assist-include (re-verify)', () => {
  it('keeps a non-UTF-8 blob withheld even when an --assist-include glob matches it', () => {
    const blob = 'PNG ' + '�' + ' rawbytes more';
    const plan = planEgress([{ path: 'image.bin', content: blob }], makeFlags({ include: ['*.bin'] }));
    const file = fileFor(plan, 'image.bin');
    assert.equal(file.included, false);
    assert.equal(file.bytes, 0);
    assert.equal(file.content, '');
    assert.equal(plan.totalBytes, 0);
  });
});
