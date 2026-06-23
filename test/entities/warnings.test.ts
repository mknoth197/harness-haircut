import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  WARNING_CATALOGUE,
  WARNING_CODES,
  symlinkAliasWarning,
  warningDocPath,
} from '../../dist/index.js';
import type { Warning } from '../../dist/index.js';

// Repo root resolved from this file (test/entities/ -> ../../), so the check
// holds regardless of the cwd `npm test` runs from.
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const EXPECTED_CODES = [
  'HH-W001',
  'HH-W003',
  'HH-W004',
  'HH-W005',
  'HH-W006',
  'HH-W007',
  'HH-W010',
  'HH-W011',
  'HH-W012',
  'HH-W013',
  'HH-W014',
];

describe('warning catalogue', () => {
  it('contains exactly the current codes', () => {
    assert.deepEqual([...WARNING_CODES].sort(), EXPECTED_CODES);
    assert.deepEqual(Object.keys(WARNING_CATALOGUE).sort(), EXPECTED_CODES);
  });

  it('does not define the retired HH-W002', () => {
    assert.equal('HH-W002' in WARNING_CATALOGUE, false);
  });

  it('gives every code a non-empty summary', () => {
    for (const code of WARNING_CODES) {
      assert.notEqual(WARNING_CATALOGUE[code].trim(), '');
    }
  });

  it('serializes to JSON with every code mapped to its summary', () => {
    const parsed = JSON.parse(JSON.stringify(WARNING_CATALOGUE)) as Record<string, string>;
    assert.deepEqual(Object.keys(parsed).sort(), EXPECTED_CODES);
    assert.equal(parsed['HH-W010'], 'unknown attachment under .agents/');
    assert.equal(
      parsed['HH-W011'],
      'frontmatter in AGENTS.md leaks verbatim into provider prompts',
    );
    assert.equal(parsed['HH-W012'], 'canonical source excluded by .gitignore');
    assert.equal(
      parsed['HH-W013'],
      'provider path skipped: a symlink aliases it onto another repo path',
    );
    assert.equal(
      parsed['HH-W014'],
      'unquoted frontmatter value contains an ambiguous " #", kept as literal text',
    );
  });

  it('links every code to its docs/warnings page', () => {
    assert.equal(warningDocPath('HH-W003'), 'docs/warnings/HH-W003.md');
  });

  // #60: warningDocPath advertises a path per code; if the file is missing the
  // link 404s. Every registered code must have its page on disk so a new code
  // (HH-W014 was the gap) cannot ship without documentation.
  it('has a docs/warnings/<code>.md file on disk for every registered code', () => {
    const missing = WARNING_CODES.filter(
      (code) => !existsSync(join(REPO_ROOT, warningDocPath(code))),
    );
    assert.deepEqual(missing, [], `missing warning doc pages: ${missing.join(', ')}`);
  });
});

describe('symlinkAliasWarning (#35)', () => {
  it('phrases an in-repo target as an in-repo symlink', () => {
    const warning = symlinkAliasWarning(
      '.claude/skills/x/SKILL.md',
      '.agents/skills/x/SKILL.md',
      'claude',
    );
    assert.equal(warning.code, 'HH-W013');
    assert.match(warning.message, /in-repo symlink to \.agents\/skills\/x\/SKILL\.md/);
    assert.equal(warning.providerId, 'claude');
  });

  it('phrases an absolute (escaping) target as outside the repository', () => {
    const warning = symlinkAliasWarning(
      '.github/copilot-instructions.md',
      '/tmp/external/copilot-instructions.md',
      'copilot',
    );
    assert.match(warning.message, /outside the repository/);
    assert.doesNotMatch(warning.message, /in-repo symlink/);
  });
});

describe('Warning objects', () => {
  it('serializes a catalogue-derived Warning with field-level fidelity (for --json output)', () => {
    const warning: Warning = {
      code: 'HH-W010',
      severity: 'warn',
      message: `${WARNING_CATALOGUE['HH-W010']}: .agents/notes.txt`,
      canonicalPath: '.agents/notes.txt',
      providerId: 'claude',
    };
    const parsed = JSON.parse(JSON.stringify(warning)) as Record<string, unknown>;
    assert.equal(parsed['code'], 'HH-W010');
    assert.equal(parsed['severity'], 'warn');
    assert.equal(parsed['message'], 'unknown attachment under .agents/: .agents/notes.txt');
    assert.equal(parsed['canonicalPath'], '.agents/notes.txt');
    assert.equal(parsed['providerId'], 'claude');
    assert.deepEqual(Object.keys(parsed).sort(), [
      'canonicalPath',
      'code',
      'message',
      'providerId',
      'severity',
    ]);
  });
});
