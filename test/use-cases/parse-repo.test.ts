import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ParseError, parseRepo, readRepoSnapshot } from '../../dist/index.js';
import type { ParseRepoResult } from '../../dist/index.js';
import { mkTempRepo } from '../_helpers/tmp-repo.ts';

/** Integration per testing.md: real filesystem in os.tmpdir(), real gateway. */
async function parseFixture(files: Record<string, string>): Promise<ParseRepoResult> {
  const repo = await mkTempRepo(files);
  try {
    return await parseRepo({ readRepo: () => readRepoSnapshot(repo.root) });
  } finally {
    await repo.cleanup();
  }
}

function assertParseError(
  files: Record<string, string>,
  messagePattern: RegExp,
): Promise<void> {
  return assert.rejects(parseFixture(files), (err: unknown) => {
    assert.equal(err instanceof ParseError, true, `expected ParseError, got ${String(err)}`);
    const parseErr = err as ParseError;
    assert.equal(parseErr.exitCode, 3);
    assert.match(parseErr.message, messagePattern);
    return true;
  });
}

describe('parseRepo — instructions', () => {
  it('lifts a root AGENTS.md into an Instruction scoped to the whole tree', async () => {
    const { ir, warnings } = await parseFixture({ 'AGENTS.md': '# Standards\n\nBe kind.\n' });
    assert.deepEqual(ir.instructions, [
      { path: 'AGENTS.md', scope: '**', body: '# Standards\n\nBe kind.\n' },
    ]);
    assert.deepEqual(warnings, []);
  });

  it('lifts a nested AGENTS.md into an Instruction scoped to its subtree', async () => {
    const { ir } = await parseFixture({
      'AGENTS.md': '# root',
      'pkg/web/AGENTS.md': '# web rules',
    });
    const nested = ir.instructions.find((i) => i.path === 'pkg/web/AGENTS.md');
    assert.deepEqual(nested, { path: 'pkg/web/AGENTS.md', scope: 'pkg/web/**', body: '# web rules' });
  });

  it('warns HH-W011 on AGENTS.md frontmatter and keeps the block as literal content', async () => {
    const content = '---\nscope: "src/**"\n---\n# Standards\n';
    const { ir, warnings } = await parseFixture({ 'AGENTS.md': content });
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.code, 'HH-W011');
    assert.equal(warnings[0]?.canonicalPath, 'AGENTS.md');
    // Frontmatter is NOT interpreted: the body is the verbatim file content.
    assert.equal(ir.instructions[0]?.body, content);
    assert.equal(ir.instructions[0]?.scope, '**');
  });

  it('lifts a scoped fragment with its scope: frontmatter glob', async () => {
    const { ir, warnings } = await parseFixture({
      '.agents/instructions/testing.md': '---\nscope: "test/**/*.ts"\n---\n# Testing rules\n',
    });
    assert.deepEqual(ir.instructions, [
      {
        path: '.agents/instructions/testing.md',
        scope: 'test/**/*.ts',
        body: '# Testing rules\n',
      },
    ]);
    assert.deepEqual(warnings, []);
  });

  it('fails with exit code 3 when a fragment lacks the scope: key', () =>
    assertParseError(
      { '.agents/instructions/prose.md': '---\ntitle: nope\n---\nbody\n' },
      /\.agents\/instructions\/prose\.md: missing required "scope:"/,
    ));

  it('fails with exit code 3 when a fragment has no frontmatter at all', () =>
    assertParseError(
      { '.agents/instructions/prose.md': 'just prose, no frontmatter\n' },
      /missing required "scope:"/,
    ));

  it('fails with exit code 3 on malformed frontmatter (bad line)', () =>
    assertParseError(
      { '.agents/instructions/bad.md': '---\nscope "src/**"\n---\nbody\n' },
      /\.agents\/instructions\/bad\.md: malformed frontmatter at line 2/,
    ));

  it('fails with exit code 3 on unterminated frontmatter', () =>
    assertParseError(
      { '.agents/instructions/bad.md': '---\nscope: "src/**"\nbody without closing fence\n' },
      /unterminated frontmatter block/,
    ));
});

describe('parseRepo — skills', () => {
  it('lifts a skill folder with name/description frontmatter and sibling attachments', async () => {
    const { ir, warnings } = await parseFixture({
      '.agents/skills/deploy/SKILL.md':
        '---\nname: deploy\ndescription: Ship the thing safely\n---\n# Deploy\n\nSteps.\n',
      '.agents/skills/deploy/scripts/run.sh': '#!/bin/sh\necho deploy\n',
      '.agents/skills/deploy/references/notes.md': 'extra context\n',
    });
    assert.equal(ir.skills.length, 1);
    const skill = ir.skills[0];
    assert.equal(skill?.name, 'deploy');
    assert.equal(skill?.description, 'Ship the thing safely');
    assert.equal(skill?.path, '.agents/skills/deploy/SKILL.md');
    assert.equal(skill?.body, '# Deploy\n\nSteps.\n');
    assert.deepEqual(
      skill?.files.map((file) => file.path).sort(),
      ['.agents/skills/deploy/references/notes.md', '.agents/skills/deploy/scripts/run.sh'],
    );
    assert.deepEqual(warnings, []);
  });

  it('fails with exit code 3 naming both paths when two skills share a name', () =>
    assertParseError(
      {
        '.agents/skills/alpha/SKILL.md': '---\nname: dup\ndescription: first\n---\n',
        '.agents/skills/beta/SKILL.md': '---\nname: dup\ndescription: second\n---\n',
      },
      /\.agents\/skills\/beta\/SKILL\.md: duplicate skill name "dup" \(already defined at \.agents\/skills\/alpha\/SKILL\.md\)/,
    ));

  it('fails with exit code 3 when SKILL.md frontmatter lacks name or description', () =>
    assertParseError(
      { '.agents/skills/incomplete/SKILL.md': '---\nname: incomplete\n---\nbody\n' },
      /requires a "description" string/,
    ));
});

describe('parseRepo — hooks', () => {
  it('lifts a valid hook file into event, name, and script', async () => {
    const script = '#!/bin/sh\nnpm run lint\n';
    const { ir, warnings } = await parseFixture({
      '.agents/hooks/pre-tool-use.lint.sh': script,
    });
    assert.deepEqual(ir.hooks, [
      {
        event: 'pre-tool-use',
        name: 'lint',
        path: '.agents/hooks/pre-tool-use.lint.sh',
        script,
      },
    ]);
    assert.deepEqual(warnings, []);
  });

  it('fails with exit code 3 on an unknown hook event, listing the valid events', () =>
    assertParseError(
      { '.agents/hooks/pre-commit.lint.sh': 'echo hi\n' },
      /unknown hook event "pre-commit"; valid events: session-start, session-end, user-prompt-submit, pre-tool-use, post-tool-use, stop, subagent-start, subagent-stop, pre-compact/,
    ));

  it('fails with exit code 3 when a hook filename lacks the <name> segment', () =>
    assertParseError(
      { '.agents/hooks/pre-tool-use.sh': 'echo hi\n' },
      /hook filename must follow <event>\.<name>\.<ext>/,
    ));
});

describe('parseRepo — attachments and unknown files', () => {
  it('records an unknown .agents/ file as an attachment and warns HH-W010', async () => {
    const { ir, warnings } = await parseFixture({
      'AGENTS.md': '# root',
      '.agents/notes.txt': 'scratch content',
    });
    assert.deepEqual(ir.attachments, [{ path: '.agents/notes.txt', content: 'scratch content' }]);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.code, 'HH-W010');
    assert.equal(warnings[0]?.canonicalPath, '.agents/notes.txt');
  });

  it('treats a skill folder without SKILL.md as unknown attachments', async () => {
    const { ir, warnings } = await parseFixture({
      '.agents/skills/broken/helper.sh': 'echo orphan\n',
    });
    assert.deepEqual(ir.skills, []);
    assert.deepEqual(ir.attachments.map((a) => a.path), ['.agents/skills/broken/helper.sh']);
    assert.equal(warnings[0]?.code, 'HH-W010');
  });

  it('skips gitignored files entirely (no IR entry, no warning)', async () => {
    const { ir, warnings } = await parseFixture({
      '.gitignore': 'notes.txt\n',
      'AGENTS.md': '# root',
      '.agents/notes.txt': 'ignored scratch content',
    });
    assert.deepEqual(ir.attachments, []);
    assert.deepEqual(warnings, []);
    assert.equal(ir.instructions.length, 1);
  });
});

describe('parseRepo — whole-repo assembly', () => {
  it('returns every canonical artifact of a mixed repo in one IR', async () => {
    const { ir, warnings } = await parseFixture({
      'AGENTS.md': '# root',
      'pkg/AGENTS.md': '# pkg',
      '.agents/instructions/arch.md': '---\nscope: "src/**/*.ts"\n---\nlayers\n',
      '.agents/skills/deploy/SKILL.md': '---\nname: deploy\ndescription: ship it\n---\nbody\n',
      '.agents/hooks/session-start.hello.sh': 'echo hello\n',
    });
    assert.equal(ir.instructions.length, 3);
    assert.equal(ir.skills.length, 1);
    assert.equal(ir.hooks.length, 1);
    assert.deepEqual(ir.attachments, []);
    assert.deepEqual(warnings, []);
  });
});
