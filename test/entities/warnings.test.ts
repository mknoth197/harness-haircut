import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { WARNING_CATALOGUE, WARNING_CODES, warningDocPath } from '../../dist/index.js';
import type { Warning } from '../../dist/index.js';

const EXPECTED_CODES = [
  'HH-W001',
  'HH-W003',
  'HH-W004',
  'HH-W005',
  'HH-W006',
  'HH-W010',
  'HH-W011',
];

describe('warning catalogue', () => {
  it('contains exactly the v0.3 codes', () => {
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

  it('survives a JSON round-trip unchanged', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(WARNING_CATALOGUE)), WARNING_CATALOGUE);
  });

  it('links every code to its docs/warnings page', () => {
    assert.equal(warningDocPath('HH-W003'), 'docs/warnings/HH-W003.md');
  });
});

describe('Warning objects', () => {
  it('survive a JSON round-trip unchanged (for --json output)', () => {
    const warning: Warning = {
      code: 'HH-W010',
      severity: 'warn',
      message: 'unknown attachment under .agents/: .agents/notes.txt',
      canonicalPath: '.agents/notes.txt',
      providerId: 'claude',
    };
    assert.deepEqual(JSON.parse(JSON.stringify(warning)), warning);
  });
});
