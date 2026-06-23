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
  isMultiImportShim,
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

  // Multi-import shim: `@AGENTS.md` followed only by more `@…` import lines is
  // a PURE shim (the trailing imports are pointers to fragments captured
  // separately, not prose) → recover '' so it manufactures no candidate.
  it('recovers empty from a pure multi-import shim (@AGENTS.md + @…instructions lines)', () => {
    const shim =
      '@AGENTS.md\n' +
      '@.github/instructions/architecture.instructions.md\n' +
      '@.github/instructions/testing.instructions.md\n' +
      '@.github/instructions/commit-style.instructions.md\n' +
      '@.github/instructions/security.instructions.md\n' +
      '@.github/instructions/docs.instructions.md\n';
    assert.equal(recoverFromShim(shim), '');
  });

  it('ignores blank lines between imports when deciding a shim is pure', () => {
    const shim =
      '@AGENTS.md\n\n' +
      '@.github/instructions/architecture.instructions.md\n\n' +
      '@.github/instructions/testing.instructions.md\n';
    assert.equal(recoverFromShim(shim), '');
  });

  // A file that mixes imports with genuine prose keeps the prose verbatim (the
  // imports ride along as harmless text rather than risking silent loss).
  it('keeps real prose around imports (@AGENTS.md + imports + prose)', () => {
    const mixed =
      '@AGENTS.md\n' +
      '@.github/instructions/testing.instructions.md\n\n' +
      '# Local notes\nUse npm test.\n';
    assert.equal(
      recoverFromShim(mixed),
      '@.github/instructions/testing.instructions.md\n\n# Local notes\nUse npm test.\n',
    );
  });

  // Finding #1: prose lines that merely BEGIN with `@` are not import lines and
  // must NOT be dropped. `@TODO real content` has embedded whitespace and no
  // `.md`, so the old `startsWith('@')` test wrongly collapsed it to '' (silent
  // data loss). The path-shape regex keeps it.
  it('keeps prose that begins with @ but is not an import line (@TODO …)', () => {
    assert.equal(
      recoverFromShim('@AGENTS.md\n@TODO real content\n'),
      '@TODO real content\n',
    );
  });

  it('keeps prose for @-prefixed lines that are not real imports (mention, JSDoc, CSS)', () => {
    // None of these match `@<path>.md`: an at-mention (no `.md`), a JSDoc tag
    // (space), a CSS at-rule (space) — all are genuine prose to preserve.
    const mixed = '@AGENTS.md\n@channel ping the team\n@param x the thing\n@media screen\n';
    assert.equal(recoverFromShim(mixed), '@channel ping the team\n@param x the thing\n@media screen\n');
  });

  // Finding #1, boundary: a single `@…notmd` line that is NOT an import keeps
  // the file from being a pure shim, so it is preserved rather than dropped.
  it('does not treat a lone @-prefixed non-import line as a pure shim', () => {
    assert.equal(recoverFromShim('@AGENTS.md\n@see https://example.com\n'), '@see https://example.com\n');
  });

  // Finding #2: a BOM-saved pure multi-import shim must still recover '' — the
  // leading BOM is stripped before the first-line check (mirroring the writer),
  // so it does not re-manufacture the spurious root-instructions contradiction.
  it('recovers empty from a BOM-prefixed pure multi-import shim', () => {
    const shim =
      '\uFEFF@AGENTS.md\n' +
      '@.github/instructions/architecture.instructions.md\n' +
      '@.github/instructions/testing.instructions.md\n';
    assert.equal(recoverFromShim(shim), '');
  });

  it('strips a leading BOM before matching the import on a single-line shim', () => {
    assert.equal(recoverFromShim('\uFEFF@AGENTS.md\n'), '');
  });

  it('strips a leading BOM and keeps prose below a BOM-saved shim', () => {
    assert.equal(recoverFromShim('\uFEFF@AGENTS.md\n# Notes\nlocal\n'), '# Notes\nlocal\n');
  });

  // Finding #4: a genuine multi-import shim with relative `@../….md` import
  // lines (a valid Claude Code pattern) is still pure → recovers ''.
  it('recovers empty from a multi-import shim with relative @../ import paths', () => {
    const shim =
      '@AGENTS.md\n' +
      '@../../.github/instructions/ui.instructions.md\n' +
      '@.github/instructions/security.instructions.md\n';
    assert.equal(recoverFromShim(shim), '');
  });
});

describe('isMultiImportShim (F2: visible drop of a pure multi-import shim)', () => {
  it('is true for @AGENTS.md followed by additional @… import lines', () => {
    const shim =
      '@AGENTS.md\n' +
      '@.github/instructions/architecture.instructions.md\n' +
      '@.github/instructions/testing.instructions.md\n';
    assert.equal(isMultiImportShim(shim), true);
  });

  it('is true through a leading BOM (mirrors recovery)', () => {
    assert.equal(
      isMultiImportShim('\uFEFF@AGENTS.md\n@.github/instructions/testing.instructions.md\n'),
      true,
    );
  });

  // The trivial single-line `@AGENTS.md` shim is the expected, noiseless case —
  // no note, so this MUST be false even though recovery also returns '' for it.
  it('is false for the bare single-line @AGENTS.md shim', () => {
    assert.equal(isMultiImportShim('@AGENTS.md\n'), false);
    assert.equal(isMultiImportShim('@AGENTS.md'), false);
  });

  it('is false when blank lines are all that follow @AGENTS.md', () => {
    assert.equal(isMultiImportShim('@AGENTS.md\n\n\n'), false);
  });

  it('is false when genuine prose rides along (recovery would keep it)', () => {
    assert.equal(
      isMultiImportShim('@AGENTS.md\n@.github/instructions/testing.instructions.md\n# Notes\nx\n'),
      false,
    );
    assert.equal(isMultiImportShim('@AGENTS.md\n@TODO real content\n'), false);
  });

  it('is false for a non-shim file (no leading @AGENTS.md import)', () => {
    assert.equal(isMultiImportShim('# Real instructions\nUse npm.\n'), false);
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
