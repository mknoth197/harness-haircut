/**
 * Unit tests for the pure candidate-text recovery helpers (C3). No I/O —
 * each function is a string transform exercised directly (testing.md
 * category 1).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizeForCompare,
  recoverFromAgentsMd,
  recoverFromShim,
  recoverFromCopilotInstructions,
} from '../../dist/index.js';

describe('normalizeForCompare', () => {
  it('treats trailing-whitespace-only differences as equal', () => {
    assert.equal(
      normalizeForCompare('# A\nUse npm test.   \n'),
      normalizeForCompare('# A\nUse npm test.\n'),
    );
  });

  it('treats a missing vs present final newline as equal', () => {
    assert.equal(normalizeForCompare('# A\nbody'), normalizeForCompare('# A\nbody\n'));
  });

  it('keeps a real content difference distinct', () => {
    assert.notEqual(normalizeForCompare('Use npm test.\n'), normalizeForCompare('Use pnpm test.\n'));
  });
});

describe('recoverFromAgentsMd', () => {
  it('returns the content verbatim', () => {
    assert.equal(recoverFromAgentsMd('# Project\n\nUse npm.\n'), '# Project\n\nUse npm.\n');
  });
});

describe('recoverFromShim', () => {
  it('strips a leading @AGENTS.md import line, keeping the body below', () => {
    assert.equal(recoverFromShim('@AGENTS.md\n\n# Notes\nlocal stuff\n'), '\n# Notes\nlocal stuff\n');
  });

  it('returns the whole content when there is no import line', () => {
    assert.equal(recoverFromShim('# Real instructions\nUse npm.\n'), '# Real instructions\nUse npm.\n');
  });

  it('returns empty when the shim has only the import line', () => {
    assert.equal(recoverFromShim('@AGENTS.md\n'), '');
  });
});

describe('recoverFromCopilotInstructions', () => {
  it('strips a SignedSource header line and the code-review note', () => {
    const file =
      '<!-- @generated SignedSource<<<aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb>>> harness-haircut DO NOT EDIT -->\n' +
      '<!-- This file exists for Copilot code review, which does not read AGENTS.md. ' +
      'AGENTS.md is the authoritative source — edit it and re-run harness-haircut apply. -->\n\n' +
      '# Project standards\n\nUse npm test.\n';
    assert.equal(recoverFromCopilotInstructions(file), '# Project standards\n\nUse npm test.\n');
  });

  it('returns the body untouched when there is no header or note', () => {
    assert.equal(
      recoverFromCopilotInstructions('# Hand-written\nUse pnpm.\n'),
      '# Hand-written\nUse pnpm.\n',
    );
  });
});
