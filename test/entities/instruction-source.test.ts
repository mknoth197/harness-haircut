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
  recoverFragmentFromCopilot,
  recoverFragmentFromClaudeRule,
  recoverFragmentFromCanonical,
  fragmentNameFromSource,
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

describe('recoverFragmentFromCopilot (F1: applyTo -> scope)', () => {
  it('parses a single applyTo glob into scope and keeps the body', () => {
    const file = '---\napplyTo: "src/**"\n---\n# Security\nNo secrets in src.\n';
    assert.deepEqual(recoverFragmentFromCopilot(file), {
      scope: 'src/**',
      body: '# Security\nNo secrets in src.\n',
    });
  });

  it('comma-joins multiple applyTo globs into one scope', () => {
    const file = '---\napplyTo: "src/**,test/**"\n---\nbody\n';
    assert.equal(recoverFragmentFromCopilot(file)?.scope, 'src/**,test/**');
  });

  it('strips a SignedSource header emitted after the frontmatter (managed repo)', () => {
    const file =
      '---\napplyTo: "src/**"\n---\n' +
      '<!-- @generated SignedSource<<<aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb>>> harness-haircut DO NOT EDIT -->\n' +
      '# Security\nNo secrets.\n';
    assert.equal(recoverFragmentFromCopilot(file)?.body, '# Security\nNo secrets.\n');
  });

  it('takes the whole post-frontmatter body when no header is present (drifted repo)', () => {
    const file = '---\napplyTo: "src/**"\n---\n# Hand-written\nstuff\n';
    assert.equal(recoverFragmentFromCopilot(file)?.body, '# Hand-written\nstuff\n');
  });

  it('returns null when there is no applyTo frontmatter to derive a scope', () => {
    assert.equal(recoverFragmentFromCopilot('# no frontmatter\nbody\n'), null);
    assert.equal(recoverFragmentFromCopilot('---\nname: x\n---\nbody\n'), null);
  });
});

describe('recoverFragmentFromClaudeRule (F1: paths -> scope)', () => {
  it('parses an inline paths array into a comma-joined scope', () => {
    const file = '---\npaths: ["src/**", "test/**"]\n---\n# Rule\nbody\n';
    assert.deepEqual(recoverFragmentFromClaudeRule(file), {
      scope: 'src/**,test/**',
      body: '# Rule\nbody\n',
    });
  });

  it('parses a block-sequence paths list into a comma-joined scope', () => {
    const file = '---\npaths:\n  - src/**\n  - test/**\n---\nbody\n';
    assert.equal(recoverFragmentFromClaudeRule(file)?.scope, 'src/**,test/**');
  });

  it('strips a SignedSource header after the frontmatter', () => {
    const file =
      '---\npaths: ["src/**"]\n---\n' +
      '<!-- @generated SignedSource<<<aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb>>> harness-haircut DO NOT EDIT -->\n' +
      '# Rule\nbody\n';
    assert.equal(recoverFragmentFromClaudeRule(file)?.body, '# Rule\nbody\n');
  });

  it('returns null when there is no paths frontmatter', () => {
    assert.equal(recoverFragmentFromClaudeRule('# no frontmatter\nbody\n'), null);
    assert.equal(recoverFragmentFromClaudeRule('---\nname: x\n---\nbody\n'), null);
  });
});

describe('recoverFragmentFromCanonical (C6 #44: scope -> scope)', () => {
  it('parses a quoted scope and returns the body verbatim', () => {
    const file = '---\nscope: "src/**"\n---\n# Security\n\nNo secrets.\n';
    assert.deepEqual(recoverFragmentFromCanonical(file), {
      scope: 'src/**',
      body: '# Security\n\nNo secrets.\n',
    });
  });

  it('round-trips a multi-glob comma-joined scope', () => {
    const file = '---\nscope: "src/**,test/**"\n---\nbody\n';
    assert.equal(recoverFragmentFromCanonical(file)?.scope, 'src/**,test/**');
  });

  it('accepts an unquoted scope scalar', () => {
    const file = '---\nscope: src/**\n---\nbody\n';
    assert.equal(recoverFragmentFromCanonical(file)?.scope, 'src/**');
  });

  it('normalizes a hand-written inline-array scope (not captured as a literal string)', () => {
    const file = '---\nscope: ["src/**", "test/**"]\n---\nbody\n';
    assert.equal(recoverFragmentFromCanonical(file)?.scope, 'src/**,test/**');
  });

  it('normalizes a hand-written block-sequence scope', () => {
    const file = '---\nscope:\n  - src/**\n  - test/**\n---\nbody\n';
    assert.equal(recoverFragmentFromCanonical(file)?.scope, 'src/**,test/**');
  });

  it('strips a SignedSource header after the frontmatter', () => {
    const file =
      '---\nscope: "src/**"\n---\n' +
      '<!-- @generated SignedSource<<<aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb>>> harness-haircut DO NOT EDIT -->\n' +
      '# Rule\nbody\n';
    assert.equal(recoverFragmentFromCanonical(file)?.body, '# Rule\nbody\n');
  });

  it('returns null when there is no scope frontmatter', () => {
    assert.equal(recoverFragmentFromCanonical('# no frontmatter\nbody\n'), null);
    assert.equal(recoverFragmentFromCanonical('---\nname: x\n---\nbody\n'), null);
  });
});

describe('fragmentNameFromSource (F1: source filename -> canonical name)', () => {
  it('strips the hh. prefix and the .instructions.md suffix (copilot)', () => {
    assert.equal(
      fragmentNameFromSource('.github/instructions/hh.security.instructions.md'),
      'security',
    );
  });

  it('strips a hand-written .instructions.md with no hh. prefix', () => {
    assert.equal(fragmentNameFromSource('.github/instructions/security.instructions.md'), 'security');
  });

  it('strips the hh. prefix and the .md suffix (claude rule)', () => {
    assert.equal(fragmentNameFromSource('.claude/rules/hh.testing.md'), 'testing');
  });

  it('handles a plain .md rule with no prefix', () => {
    assert.equal(fragmentNameFromSource('.claude/rules/testing.md'), 'testing');
  });
});
