/**
 * Secret-scan entity — UNIT tests (testing.md category 1, pure, no I/O).
 *
 * Pins the C5 (#30) egress secret scanner against the story
 * `docs/stories/14-C5-assist-egress-redaction.md` and the Fable threat model
 * `docs/security/assist-egress-threat-model.md`:
 *
 *   - U2  — every enumerated high-confidence credential shape is detected as
 *           a `high` finding (the hard-block tier), with file/line/rule
 *           attribution and a masked excerpt that never echoes the secret.
 *   - EV2 — `redactFindings` replaces allowed spans with the stable
 *           `[REDACTED:<rule>]` placeholder, offsets staying byte-exact.
 *   - UN1 — a broken rule pattern makes the scan THROW (fail-closed); it must
 *           never silently skip a rule and let bytes leave unscanned.
 *
 * ALL fixtures below are SYNTHETIC: token-shaped strings are assembled at
 * runtime from concatenation/`repeat` so no real credential (and no
 * scanner-flaggable literal) ever appears in this repo.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  BUILTIN_SECRET_RULES,
  redactFindings,
  scanForSecrets,
  shannonEntropy,
} from '../../dist/index.js';
import type { SecretFinding, SecretRule } from '../../dist/index.js';

// --- synthetic credential-shaped fixtures (constructed, never literal) ---
const AWS_AKIA = 'AKIA' + 'A'.repeat(16);
const AWS_ASIA = 'ASIA' + '0123456789' + 'ABCDEF';
const pemBegin = (label: string): string => '-----BEGIN ' + label + 'PRIVATE KEY-----';
const JWT = ['eyJ' + 'AbCdEfGh' + 'IjKl', 'MnOpQrStUv', 'WxYz012345'].join('.');
const GITHUB_GHP = 'ghp_' + 'A'.repeat(36);
const GITHUB_PAT = 'github_pat_' + '0123456789' + 'ABCDEFGHIJKL';
const GITLAB_PAT = 'glpat-' + 'Aa0Bb1' + 'Cc2Dd3Ee4Ff5Gg';
const SLACK_XOXB = 'xoxb-' + '0123456789' + 'abcdef';
const GOOGLE_KEY = 'AIza' + 'Sy' + 'B'.repeat(33); // AIza + exactly 35 chars
const ANTHROPIC_KEY = 'sk-' + 'ant-' + 'x'.repeat(24);
// OpenAI's `sk-` rule additionally requires the body to clear the entropy
// floor (the prefix is too short to anchor on alone), so this fixture is a
// realistic high-entropy key body, not a repeated char.
const OPENAI_KEY = 'sk-' + 'T3hK9wL2pR5tZ8vN4qX7bM1cF6yH0jD5sG3aE';
const NPM_TOKEN = 'npm_' + 'a1B2'.repeat(9); // npm_ + exactly 36 chars
// 24 distinct [A-Za-z0-9] chars -> Shannon entropy log2(24) ~ 4.58 >= 4.0
const HIGH_ENTROPY = 'Zq8Xv3' + 'Lw9Tn5' + 'Rd2Yf7' + 'Km4Jh6';

/** Scans a one-line fixture and returns the rule ids that fired. */
function ruleIdsIn(content: string): string[] {
  return scanForSecrets('AGENTS.md', content).map((f) => f.ruleId);
}

describe('scanForSecrets() built-in high-confidence rules (C5 U2 hard-block tier)', () => {
  const highSamples: ReadonlyArray<{ ruleId: string; label: string; sample: string }> = [
    { ruleId: 'aws-access-key-id', label: 'an AWS access key id (AKIA variant)', sample: AWS_AKIA },
    { ruleId: 'aws-access-key-id', label: 'an AWS access key id (ASIA variant)', sample: AWS_ASIA },
    { ruleId: 'pem-private-key', label: 'a generic PEM private key header', sample: pemBegin('') },
    { ruleId: 'pem-private-key', label: 'an RSA PEM private key header', sample: pemBegin('RSA ') },
    {
      ruleId: 'pem-private-key',
      label: 'an OPENSSH PEM private key header',
      sample: pemBegin('OPENSSH '),
    },
    { ruleId: 'jwt', label: 'a three-segment JWT', sample: JWT },
    { ruleId: 'github-token', label: 'a GitHub ghp_ token', sample: GITHUB_GHP },
    { ruleId: 'github-token', label: 'a GitHub fine-grained github_pat_ token', sample: GITHUB_PAT },
    { ruleId: 'gitlab-pat', label: 'a GitLab personal access token', sample: GITLAB_PAT },
    { ruleId: 'slack-token', label: 'a Slack xoxb- token', sample: SLACK_XOXB },
    { ruleId: 'google-api-key', label: 'a Google API key (AIza + 35 chars)', sample: GOOGLE_KEY },
    { ruleId: 'anthropic-api-key', label: 'an Anthropic sk-ant- key', sample: ANTHROPIC_KEY },
    { ruleId: 'openai-api-key', label: 'an OpenAI sk- key', sample: OPENAI_KEY },
    { ruleId: 'npm-token', label: 'an npm token (npm_ + 36 chars)', sample: NPM_TOKEN },
  ];

  for (const { ruleId, label, sample } of highSamples) {
    it(`flags ${label} as a high-severity ${ruleId} finding`, () => {
      const findings = scanForSecrets('AGENTS.md', `fixture value ${sample} end\n`);
      assert.deepEqual(
        findings.map((f) => f.ruleId),
        [ruleId],
      );
      assert.equal(findings[0]!.severity, 'high');
    });
  }

  it('reports an Anthropic key only as anthropic-api-key, never as openai-api-key (negative lookahead)', () => {
    const ids = ruleIdsIn(`fixture value ${ANTHROPIC_KEY} end\n`);
    assert.deepEqual(ids, ['anthropic-api-key']);
    assert.equal(ids.includes('openai-api-key'), false);
  });

  it('does not flag a Google-looking key with only 34 chars after AIza', () => {
    assert.deepEqual(ruleIdsIn(`fixture value ${'AIza' + 'B'.repeat(34)} end\n`), []);
  });

  it('flags an over-long npm-shaped token too (token length is a floor, fail-closed)', () => {
    assert.deepEqual(ruleIdsIn(`fixture value ${'npm_' + 'a1B2'.repeat(9) + 'Z'} end\n`), [
      'npm-token',
    ]);
  });
});

describe('scanForSecrets() high-entropy-string rule (U2 keyword adjacency + entropy floor)', () => {
  // Threat-model wording: "high-entropy strings adjacent to
  // token|secret|password|api_key|credential" — keyword match is per line,
  // case-insensitive.
  for (const keyword of ['token', 'PASSWORD', 'Api_Key', 'credential']) {
    it(`flags a 24-char high-entropy string on a line mentioning "${keyword}"`, () => {
      const findings = scanForSecrets('AGENTS.md', `${keyword} = ${HIGH_ENTROPY}\n`);
      assert.deepEqual(
        findings.map((f) => f.ruleId),
        ['high-entropy-string'],
      );
      assert.equal(findings[0]!.severity, 'high');
    });
  }

  it('ignores the same high-entropy string on a line with no credential keyword', () => {
    assert.deepEqual(ruleIdsIn(`value = ${HIGH_ENTROPY}\n`), []);
  });

  it('ignores a low-entropy 30-char string even on a password line', () => {
    assert.deepEqual(ruleIdsIn(`password = ${'a'.repeat(30)}\n`), []);
  });
});

describe('scanForSecrets() medium rules (threat-model WARN tier, never blocking)', () => {
  for (const ip of ['10.1.2.3', '192.168.1.100', '172.16.0.1', '172.31.255.255']) {
    it(`flags private address ${ip} as a medium rfc1918-ip finding`, () => {
      const findings = scanForSecrets('AGENTS.md', `host lives at ${ip} internally\n`);
      assert.deepEqual(
        findings.map((f) => f.ruleId),
        ['rfc1918-ip'],
      );
      assert.equal(findings[0]!.severity, 'medium');
    });
  }

  it('does not flag 172.15.0.1 (just below the RFC1918 172.16/12 block)', () => {
    assert.deepEqual(ruleIdsIn('host lives at 172.15.0.1 publicly\n'), []);
  });

  it('does not flag the public resolver 8.8.8.8', () => {
    assert.deepEqual(ruleIdsIn('resolver is 8.8.8.8 upstream\n'), []);
  });

  it('flags a plain email address as a medium email-address finding', () => {
    const findings = scanForSecrets('AGENTS.md', 'contact dev@example.com for access\n');
    assert.deepEqual(
      findings.map((f) => f.ruleId),
      ['email-address'],
    );
    assert.equal(findings[0]!.severity, 'medium');
  });
});

describe('scanForSecrets() finding fields (U2: name file + line + rule, masked excerpt)', () => {
  const content = `clean first line\nhas ${AWS_AKIA} inline\nlast line\n`;

  it('reports a 1-based line number for a match in multi-line content', () => {
    const findings = scanForSecrets('docs/AGENTS.md', content);
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.line, 2);
    assert.equal(findings[0]!.path, 'docs/AGENTS.md');
  });

  it('reports start/end offsets spanning exactly the matched secret', () => {
    const finding = scanForSecrets('docs/AGENTS.md', content)[0]!;
    assert.equal(finding.start, content.indexOf(AWS_AKIA));
    assert.equal(finding.end, finding.start + AWS_AKIA.length);
    assert.equal(content.slice(finding.start, finding.end), AWS_AKIA);
  });

  it('masks the excerpt to first-4-chars + ellipsis and never echoes the full secret', () => {
    const finding = scanForSecrets('docs/AGENTS.md', content)[0]!;
    assert.equal(finding.excerpt, 'AKIA…');
    assert.equal(finding.excerpt.includes(AWS_AKIA), false);
  });
});

describe('scanForSecrets() options (C5 acceptance: extend/suppress rules)', () => {
  it('suppressRules removes a built-in rule so its match no longer fires', () => {
    const findings = scanForSecrets('AGENTS.md', `fixture value ${AWS_AKIA} end\n`, {
      suppressRules: ['aws-access-key-id'],
    });
    assert.deepEqual(findings, []);
  });

  it('extraRules appends a custom rule that fires with its own id and severity', () => {
    const corpRule: SecretRule = {
      id: 'corp-ticket',
      description: 'synthetic corp marker',
      severity: 'high',
      pattern: 'CORP-[0-9]{6}',
    };
    const findings = scanForSecrets('AGENTS.md', 'see CORP-123456 for details\n', {
      extraRules: [corpRule],
    });
    assert.deepEqual(
      findings.map((f) => f.ruleId),
      ['corp-ticket'],
    );
    assert.equal(findings[0]!.severity, 'high');
  });

  it('throws on an extraRules entry with an invalid regex pattern (UN1: fail closed, never send-on-error)', () => {
    const broken: SecretRule = {
      id: 'broken-rule',
      description: 'malformed pattern',
      severity: 'high',
      pattern: '[unclosed',
    };
    assert.throws(() => scanForSecrets('AGENTS.md', 'anything\n', { extraRules: [broken] }), SyntaxError);
  });
});

describe('redactFindings() (EV2: stable [REDACTED:<rule>] placeholder before send)', () => {
  it('replaces a single allowed finding with its [REDACTED:<ruleId>] placeholder', () => {
    const content = `id ${AWS_AKIA} end\n`;
    const findings = scanForSecrets('AGENTS.md', content);
    const redacted = redactFindings(content, findings);
    assert.equal(redacted, 'id [REDACTED:aws-access-key-id] end\n');
    assert.equal(redacted.includes(AWS_AKIA), false);
  });

  it('replaces two findings with offsets staying correct regardless of input order', () => {
    const content = `a ${SLACK_XOXB} mid ${AWS_AKIA} z\n`;
    // Reverse the scan order to pin that redaction sorts spans itself.
    const findings = [...scanForSecrets('AGENTS.md', content)].reverse();
    const redacted = redactFindings(content, findings);
    assert.equal(redacted, 'a [REDACTED:slack-token] mid [REDACTED:aws-access-key-id] z\n');
    assert.equal(redacted.includes(SLACK_XOXB), false);
    assert.equal(redacted.includes(AWS_AKIA), false);
  });

  it('merges overlapping findings into one placeholder with no secret bytes surviving', () => {
    const content = '0123456789abcdef';
    const overlap = (ruleId: string, start: number, end: number): SecretFinding => ({
      ruleId,
      severity: 'high',
      path: 'AGENTS.md',
      line: 1,
      start,
      end,
      excerpt: `${content.slice(start, start + 4)}…`,
    });
    const redacted = redactFindings(content, [overlap('rule-a', 2, 10), overlap('rule-b', 6, 14)]);
    // Leftmost-starting rule labels the merged span; the union 2..14 is gone.
    assert.equal(redacted, '01[REDACTED:rule-a]ef');
    assert.equal(redacted.includes('23456789abcd'), false);
  });

  it('returns content unchanged for an empty findings array', () => {
    assert.equal(redactFindings('hello world\n', []), 'hello world\n');
  });
});

describe('shannonEntropy()', () => {
  it('returns 0 for the empty string', () => {
    assert.equal(shannonEntropy(''), 0);
  });

  it('returns 0 for a single-character run like "aaaa…"', () => {
    assert.equal(shannonEntropy('a'.repeat(30)), 0);
  });

  it('returns exactly 2 bits/char for four equally frequent characters', () => {
    assert.equal(shannonEntropy('abcd'), 2);
  });

  it('scores random-looking input above the 4.0 threshold and above a uniform run', () => {
    const random = shannonEntropy(HIGH_ENTROPY);
    assert.equal(random > 4.0, true);
    assert.equal(random > shannonEntropy('a'.repeat(HIGH_ENTROPY.length)), true);
  });
});

describe('scanForSecrets() output ordering', () => {
  it('sorts findings by position even when rule order would report them reversed', () => {
    // slack-token sits AFTER aws-access-key-id in BUILTIN_SECRET_RULES, so an
    // earlier-positioned slack match is pushed later — the sort must fix it.
    const awsIndex = BUILTIN_SECRET_RULES.findIndex((r) => r.id === 'aws-access-key-id');
    const slackIndex = BUILTIN_SECRET_RULES.findIndex((r) => r.id === 'slack-token');
    assert.equal(awsIndex < slackIndex, true);

    const content = `x ${SLACK_XOXB} then ${AWS_AKIA} y\n`;
    const findings = scanForSecrets('AGENTS.md', content);
    assert.deepEqual(
      findings.map((f) => f.ruleId),
      ['slack-token', 'aws-access-key-id'],
    );
    assert.equal(findings[0]!.start < findings[1]!.start, true);
  });
});

// --- C5 adversarial-review regressions (U2 bypass hardening) ---

describe('scanForSecrets() — shape rules fire when glued after a word char (review: critical)', () => {
  // The old leading \b meant a real token glued immediately after a word char
  // (e.g. `key=xghp_…`) had no boundary and was MISSED entirely. Each
  // distinctive-prefix shape must now fire glued after a letter.
  const glued: ReadonlyArray<{ ruleId: string; sample: string }> = [
    { ruleId: 'aws-access-key-id', sample: AWS_AKIA },
    { ruleId: 'jwt', sample: JWT },
    { ruleId: 'github-token', sample: GITHUB_GHP },
    { ruleId: 'gitlab-pat', sample: GITLAB_PAT },
    { ruleId: 'slack-token', sample: SLACK_XOXB },
    { ruleId: 'google-api-key', sample: GOOGLE_KEY },
    { ruleId: 'anthropic-api-key', sample: ANTHROPIC_KEY },
    { ruleId: 'npm-token', sample: NPM_TOKEN },
  ];
  for (const { ruleId, sample } of glued) {
    it(`flags ${ruleId} when glued immediately after a word char`, () => {
      const ids = scanForSecrets('AGENTS.md', `key=x${sample}\n`).map((f) => f.ruleId);
      assert.equal(ids.includes(ruleId), true);
    });
  }

  it('flags a glued OpenAI key (high entropy) but not an ordinary hyphenated word-chain', () => {
    assert.equal(
      scanForSecrets('AGENTS.md', `key=x${OPENAI_KEY}\n`)
        .map((f) => f.ruleId)
        .includes('openai-api-key'),
      true,
    );
    // `task-oriented-…` satisfies the sk- shape but is low-entropy prose — the
    // entropy gate keeps it from a false-positive hard block.
    const phrase = 'we follow a task-oriented-development-workflow-and-conventions approach\n';
    assert.equal(
      scanForSecrets('AGENTS.md', phrase)
        .map((f) => f.ruleId)
        .includes('openai-api-key'),
      false,
    );
  });
});

describe('scanForSecrets() — invisible/format chars cannot split a token (review)', () => {
  it('detects a token split by a zero-width space and redacts the whole original span', () => {
    const zwsp = '​';
    const token = 'ghp_' + 'B'.repeat(36);
    const split = 'ghp_' + 'B'.repeat(18) + zwsp + 'B'.repeat(18);
    const content = `value ${split} end\n`;
    const findings = scanForSecrets('AGENTS.md', content);
    assert.equal(findings.map((f) => f.ruleId).includes('github-token'), true);
    const redacted = redactFindings(content, findings.filter((f) => f.ruleId === 'github-token'));
    // The zero-width char sat inside the secret, so the redaction must remove
    // the whole run — no fragment of the token (or the splitter) survives.
    assert.equal(redacted.includes('BBBB'), false);
    assert.equal(redacted.includes(zwsp), false);
    assert.match(redacted, /\[REDACTED:github-token\]/);
    void token;
  });
});

describe('scanForSecrets() — keyword adjacency spans the previous line and CRLF files (review)', () => {
  it('fires when the credential keyword is on the line ABOVE the value', () => {
    const content = `aws secret access key\n${HIGH_ENTROPY}Qx7\n`;
    const ids = scanForSecrets('AGENTS.md', content).map((f) => f.ruleId);
    assert.equal(ids.includes('high-entropy-string'), true);
  });

  it('fires on a CRLF same-line keyword=value (line endings normalized)', () => {
    const content = `prefix\r\ntoken=${HIGH_ENTROPY}Qx7\r\nmore\r\n`;
    const ids = scanForSecrets('AGENTS.md', content).map((f) => f.ruleId);
    assert.equal(ids.includes('high-entropy-string'), true);
  });
});

describe('scanForSecrets() — long-hex secrets (review: 64-hex escapes the 4.0 entropy floor)', () => {
  it('flags a 64-hex secret on a keyword line via the dedicated hex rule', () => {
    const hex = 'a3f9c1d2e4b5078690fedcba12345678a3f9c1d2e4b5078690fedcba12345678';
    const ids = scanForSecrets('AGENTS.md', `deploy_token = ${hex}\n`).map((f) => f.ruleId);
    assert.equal(ids.includes('hex-secret'), true);
  });

  it('does not flag a 40-hex git SHA when no credential keyword is near', () => {
    const sha = '0123456789abcdef0123456789abcdef01234567';
    const ids = scanForSecrets('AGENTS.md', `commit ${sha} landed the fix\n`).map((f) => f.ruleId);
    assert.equal(ids.includes('hex-secret'), false);
  });
});

describe('scanForSecrets() — dotted high-entropy value (review)', () => {
  it('flags a dotted high-entropy value on a keyword line as one run', () => {
    const dotted = 'aB3.xK9.mQ7.wL2.pR5.tZ8.vN4.kH1.jD6';
    const ids = scanForSecrets('AGENTS.md', `api_key: ${dotted}\n`).map((f) => f.ruleId);
    assert.equal(ids.includes('high-entropy-string'), true);
  });
});

// --- C5 re-verify regressions (second adversarial pass) ---

describe('scanForSecrets() — combining marks & variation selectors cannot split a token', () => {
  const invisibles: ReadonlyArray<{ label: string; cp: number }> = [
    { label: 'combining acute U+0301', cp: 0x0301 },
    { label: 'combining grapheme joiner U+034F', cp: 0x034f },
    { label: 'variation selector-16 U+FE0F', cp: 0xfe0f },
    { label: 'combining enclosing circle U+20DD', cp: 0x20dd },
  ];
  for (const { label, cp } of invisibles) {
    it(`detects a github token split by ${label} (no keyword needed)`, () => {
      const token = 'ghp_' + 'aB9cD8eF7gH6iJ5kL4mN3oP2qR1sT0uV9wX8yZ';
      const split = token.slice(0, 10) + String.fromCodePoint(cp) + token.slice(10);
      // Prose with NO credential keyword — the shape rule must fire on its own.
      const content = `Authentication uses ${split} during sync.\n`;
      const findings = scanForSecrets('AGENTS.md', content);
      assert.equal(findings.map((f) => f.ruleId).includes('github-token'), true);
      const redacted = redactFindings(
        content,
        findings.filter((f) => f.ruleId === 'github-token'),
      );
      assert.equal(redacted.includes(String.fromCodePoint(cp)), false);
      assert.match(redacted, /\[REDACTED:github-token\]/);
    });
  }
});

describe('scanForSecrets() — control chars & spacing marks cannot split a token either', () => {
  // The strip must cover not just Cf/Mn/Me but ALL marks (incl. Mc) and
  // control chars (TAB/BEL/DEL/C1) — a TAB wedged into a token is invisible
  // enough to evade a shape rule but means nothing as text.
  const splitters: ReadonlyArray<{ label: string; cp: number }> = [
    { label: 'TAB U+0009', cp: 0x09 },
    { label: 'BEL U+0007', cp: 0x07 },
    { label: 'DEL U+007F', cp: 0x7f },
    { label: 'C1 NEL U+0085', cp: 0x85 },
    { label: 'spacing mark U+0903', cp: 0x0903 },
  ];
  for (const { label, cp } of splitters) {
    it(`detects an AWS key split by ${label} (no keyword needed)`, () => {
      const token = 'AKIA' + 'B'.repeat(16);
      const split = token.slice(0, 8) + String.fromCodePoint(cp) + token.slice(8);
      const ids = scanForSecrets('AGENTS.md', `notes ${split} end\n`).map((f) => f.ruleId);
      assert.equal(ids.includes('aws-access-key-id'), true);
    });
  }
});

describe('scanForSecrets() — CRLF with the keyword on the line above', () => {
  it('fires a keyword-gated rule when keyword line and value line are CRLF-separated', () => {
    const hex = '0123456789abcdef'.repeat(4);
    const crlf = `CI_DEPLOY_TOKEN\r\n${hex}\r\nmore\r\n`;
    assert.equal(ruleIdsIn(crlf).includes('hex-secret'), true);
  });
});

describe('scanForSecrets() — high-entropy rule no longer false-blocks URLs/paths', () => {
  it('does not flag a credential-related URL on a keyword line (/ excluded from the class)', () => {
    assert.deepEqual(
      ruleIdsIn('see the api key reference at https://api.example.com/v1/credentials/list\n'),
      [],
    );
  });

  it('does not flag a file path on a keyword line', () => {
    assert.deepEqual(
      ruleIdsIn('the api key lives in .agents/instructions/software-architecture.md\n'),
      [],
    );
  });

  it('still flags a genuine high-entropy secret on a keyword line', () => {
    assert.equal(ruleIdsIn(`secret = ${HIGH_ENTROPY}Qx7Zt2\n`).includes('high-entropy-string'), true);
  });
});

describe('scanForSecrets() — homoglyph-substituted credentials cannot evade the shape rules', () => {
  // A human reads `АKIA…` (Cyrillic А) as the AWS prefix `AKIA…`, but the
  // ASCII shape rule never fired before the normalization pass folded the
  // lookalike to its skeleton. Each variant swaps ONE glyph of `AKIA` for a
  // confusable from a different family and must still flag aws-access-key-id.
  const akiaTail = 'B'.repeat(16);
  const aLookalikes: ReadonlyArray<{ label: string; cp: number }> = [
    { label: 'Cyrillic capital A U+0410', cp: 0x0410 },
    { label: 'Greek capital Alpha U+0391', cp: 0x0391 },
    { label: 'fullwidth A U+FF21 (folded by NFKC)', cp: 0xff21 },
    { label: 'mathematical bold A U+1D400 (folded by NFKC)', cp: 0x1d400 },
  ];
  for (const { label, cp } of aLookalikes) {
    it(`flags AKIA with its leading A as ${label}`, () => {
      const sample = String.fromCodePoint(cp) + 'KIA' + akiaTail;
      assert.equal(ruleIdsIn(`notes ${sample} end\n`).includes('aws-access-key-id'), true);
    });
  }

  it('flags AKIA with a Cyrillic capital I U+0406 substituted for the I', () => {
    const sample = 'AK' + String.fromCodePoint(0x0406) + 'A' + akiaTail;
    assert.equal(ruleIdsIn(`notes ${sample} end\n`).includes('aws-access-key-id'), true);
  });

  it('flags a github token whose ghp_ prefix hides a Cyrillic small p U+0440', () => {
    const token = 'gh' + String.fromCodePoint(0x0440) + '_' + 'a'.repeat(36);
    assert.equal(ruleIdsIn(`auth ${token} end\n`).includes('github-token'), true);
  });

  it('does not turn ordinary Cyrillic prose on a keyword line into a finding', () => {
    // `пароль` folds to a short, low-entropy run — far from a credential shape —
    // so the fold must not manufacture a secret out of legitimate prose.
    const cyrillicWord = String.fromCodePoint(0x043f, 0x0430, 0x0440, 0x043e, 0x043b, 0x044c);
    assert.deepEqual(ruleIdsIn(`password note: ${cyrillicWord}\n`), []);
  });

  it('keeps offsets byte-exact and redacts the whole secret when it contains a homoglyph', () => {
    // The matched span must cover the ORIGINAL (homoglyph-bearing) bytes, not
    // the folded view, so redaction removes the entire secret — the Cyrillic
    // char included — leaving no recoverable fragment.
    const cyrA = String.fromCodePoint(0x0410);
    const token = cyrA + 'KIA' + 'B'.repeat(16);
    const content = `id ${token} end\n`;
    const findings = scanForSecrets('AGENTS.md', content);
    assert.deepEqual(
      findings.map((f) => f.ruleId),
      ['aws-access-key-id'],
    );
    const finding = findings[0]!;
    assert.equal(finding.start, content.indexOf(cyrA));
    assert.equal(finding.end, finding.start + token.length);
    assert.equal(content.slice(finding.start, finding.end), token);
    // The masked excerpt shows the ASCII skeleton, never echoing the homoglyph.
    assert.equal(finding.excerpt, 'AKIA…');
    const redacted = redactFindings(content, findings);
    assert.equal(redacted, 'id [REDACTED:aws-access-key-id] end\n');
    assert.equal(redacted.includes(cyrA), false);
    assert.equal(redacted.includes('BBBB'), false);
  });
});
