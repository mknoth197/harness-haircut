import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  AggregateParseError,
  ParseError,
  claudeAdapter,
  copilotAdapter,
  parseRepo,
  readRepoSnapshot,
} from '../../dist/index.js';
import type { ParseRepoResult } from '../../dist/index.js';
import { ctxWith } from '../_helpers/ir.ts';
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

describe('parseRepo — frontmatter subset honesty', () => {
  // #58: an unquoted value containing " #" is NO LONGER a hard error. A strict
  // YAML parser reads " #..." as a comment, but the real consumer (Claude Code)
  // keeps the whole value, so we match the consumer: the FULL text is preserved
  // literally and HH-W014 advises quoting it. A working skill must never abort
  // the whole audit over this.
  it('keeps an unquoted scalar with " #" literal and warns HH-W014 (not exit 3)', async () => {
    const { ir, warnings } = await parseFixture({
      '.agents/instructions/c.md': '---\nscope: src/** # applies to source\n---\nbody\n',
    });
    // The " #..." remainder is part of the value, byte-for-byte.
    assert.equal(ir.instructions[0]?.scope, 'src/** # applies to source');
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.code, 'HH-W014');
    assert.equal(warnings[0]?.canonicalPath, '.agents/instructions/c.md');
    assert.match(warnings[0]?.message ?? '', /ambiguous " #"/);
  });

  it('fails with exit code 3 on inline array items containing quotes', () =>
    assertParseError(
      { '.agents/instructions/q.md': '---\nscope: "src/**"\ntags: ["a", "b"]\n---\nbody\n' },
      /contains quoted items, which are outside the supported subset/,
    ));

  it('fails with exit code 3 when a fragment has an empty frontmatter block (scope still missing)', () =>
    assertParseError(
      { '.agents/instructions/empty.md': '---\n---\nbody\n' },
      /missing required "scope:"/,
    ));

  it('fails with exit code 3 when scope: is a list instead of a string glob', () =>
    assertParseError(
      { '.agents/instructions/list.md': '---\nscope:\n- src/**\n---\nbody\n' },
      /"scope:" must be a non-empty glob string/,
    ));

  it('parses a BOM-prefixed fragment with valid scope', async () => {
    const { ir, warnings } = await parseFixture({
      '.agents/instructions/bom.md': '\uFEFF---\nscope: "src/**"\n---\nbody\n',
    });
    assert.deepEqual(ir.instructions, [
      { path: '.agents/instructions/bom.md', scope: 'src/**', body: 'body\n' },
    ]);
    assert.deepEqual(warnings, []);
  });

  // #36: inside a cleanly-quoted scalar, ` #` is literal text \u2014 YAML cannot
  // open a comment inside quotes. Issue/PR references ("work on issue #N")
  // are ubiquitous in real skill descriptions and had no legal spelling.
  it('accepts a double-quoted scalar containing " #" as literal text', async () => {
    const { ir, warnings } = await parseFixture({
      'AGENTS.md': '# T\n',
      '.agents/skills/demo/SKILL.md':
        '---\nname: demo\ndescription: "work on issue #N from the template"\n---\nBody.\n',
    });
    assert.equal(ir.skills[0]?.description, 'work on issue #N from the template');
    assert.deepEqual(warnings, []);
  });

  it('accepts a single-quoted scalar containing " #" as literal text', async () => {
    const { ir, warnings } = await parseFixture({
      '.agents/skills/demo/SKILL.md':
        "---\nname: demo\ndescription: 'fixes issue #12'\n---\nBody.\n",
    });
    assert.equal(ir.skills[0]?.description, 'fixes issue #12');
    // #36: a cleanly-quoted value is unambiguous — no HH-W014.
    assert.deepEqual(warnings, []);
  });

  it('accepts a quoted block-sequence item containing " #"', async () => {
    const { ir, warnings } = await parseFixture({
      '.agents/skills/demo/SKILL.md':
        '---\nname: demo\ndescription: d\nnotes:\n- "see issue #3"\n---\nBody.\n',
    });
    assert.equal(ir.skills.length, 1);
    assert.deepEqual(warnings, []);
  });

  // #36/#47 exemption preserved: a fully-quoted value carrying a "#47" issue
  // ref parses with NO warning — only AMBIGUOUS (unquoted / dirty-quoted) " #"
  // earns HH-W014.
  it('does not warn on a cleanly double-quoted value containing "#47"', async () => {
    const { ir, warnings } = await parseFixture({
      '.agents/skills/demo/SKILL.md':
        '---\nname: demo\ndescription: d\nargument-hint: "address #47"\n---\nBody.\n',
    });
    assert.equal(ir.skills.length, 1);
    assert.deepEqual(warnings, []);
  });

  // #58: a value that is NOT cleanly quoted but contains " #" (here an interior
  // quote leaves " #x" looking comment-like) is no longer rejected — it warns
  // and the full text is kept, same as any other ambiguous " #".
  it('warns (not exit 3) on an ambiguously quoted scalar with " #" after an interior quote', async () => {
    const { ir, warnings } = await parseFixture({
      '.agents/skills/demo/SKILL.md': '---\nname: demo\ndescription: "a" #x"\n---\nBody.\n',
    });
    // No exit 3: it warns. unquote() strips the outer matching quote pair
    // (`"a" #x"` -> `a" #x`); the " #" is no longer treated as a comment.
    assert.equal(ir.skills[0]?.description, 'a" #x');
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.code, 'HH-W014');
  });

  it('names a quoting remediation in the HH-W014 advisory for an unquoted " #"', async () => {
    const { warnings } = await parseFixture({
      '.agents/instructions/c.md': '---\nscope: src/** # comment\n---\nbody\n',
    });
    // Quote-free value: either quote style works, so advise "Quote the whole value".
    assert.match(warnings[0]?.message ?? '', /Quote the whole value/);
  });

  // (c) When the value already contains a literal double-quote, double-quoting
  // it would not round-trip (the subset does no escape processing), so the
  // advisory must steer the user to SINGLE quotes (or rewording) instead.
  it('advises single-quoting when the " #" value already contains a double-quote', async () => {
    const { ir, warnings } = await parseFixture({
      '.agents/skills/demo/SKILL.md':
        '---\nname: demo\ndescription: say "hi" before issue #9\n---\nBody.\n',
    });
    assert.equal(ir.skills[0]?.description, 'say "hi" before issue #9');
    assert.equal(warnings[0]?.code, 'HH-W014');
    assert.match(warnings[0]?.message ?? '', /Single-quote the whole value/);
    assert.doesNotMatch(warnings[0]?.message ?? '', /Double-quote the whole value/);
  });

  // Symmetric to (c): a value with a literal single-quote can't be single-quoted,
  // so advise double-quoting.
  it('advises double-quoting when the " #" value already contains a single-quote', async () => {
    const { warnings } = await parseFixture({
      '.agents/skills/demo/SKILL.md':
        "---\nname: demo\ndescription: it's done, see issue #9\n---\nBody.\n",
    });
    assert.equal(warnings[0]?.code, 'HH-W014');
    assert.match(warnings[0]?.message ?? '', /Double-quote the whole value/);
  });

  // Finding 4 (#60): a value containing BOTH quote characters can wear neither
  // style faithfully (the subset does no escape processing), so the advisory
  // must steer to REWORDING — never recommend an unusable quote style.
  it('advises rewording when the " #" value contains both a single- and double-quote', async () => {
    const { ir, warnings } = await parseFixture({
      '.agents/skills/demo/SKILL.md':
        '---\nname: demo\ndescription: it\'s a "thing", see issue #9\n---\nBody.\n',
    });
    assert.equal(ir.skills[0]?.description, 'it\'s a "thing", see issue #9');
    assert.equal(warnings[0]?.code, 'HH-W014');
    assert.match(warnings[0]?.message ?? '', /reword it to drop the " #"/);
    // It must NOT recommend a quote style the value cannot actually wear.
    assert.doesNotMatch(warnings[0]?.message ?? '', /Single-quote the whole value/);
    assert.doesNotMatch(warnings[0]?.message ?? '', /Double-quote the whole value/);
  });

  // Finding 1 (#60): an inline-array value containing " #" in ANY item is NOT
  // silent — the shared pre-check (warnAmbiguousComment on the whole unquoted
  // `rest`) sees the bracket string `[a #1, b]`, which contains the " #"
  // substring, and warns EXACTLY ONCE. (The reviewer suspected this branch
  // shipped silently; it does not — covered here so a refactor can't regress
  // it into either silence or a double-warning.)
  it('warns HH-W014 exactly once for a " #" in the first inline-array item', async () => {
    const { ir, warnings } = await parseFixture({
      '.agents/skills/demo/SKILL.md':
        '---\nname: demo\ndescription: d\ntags: [a #1, b]\n---\nBody.\n',
    });
    // The item is kept byte-for-byte, including the comment-like remainder.
    assert.equal(ir.skills[0]?.frontmatter.includes('tags: [a #1, b]'), true);
    const w14 = warnings.filter((w) => w.code === 'HH-W014');
    assert.equal(w14.length, 1, 'expected exactly one HH-W014 (not silent, not doubled)');
    assert.equal(w14[0]?.canonicalPath, '.agents/skills/demo/SKILL.md');
    assert.match(w14[0]?.message ?? '', /ambiguous " #"/);
  });

  // The " #" is equally caught when it sits in a LATER item — the pre-check is
  // over the whole bracket, so position does not matter.
  it('warns HH-W014 once for a " #" in a later inline-array item', async () => {
    const { warnings } = await parseFixture({
      '.agents/skills/demo/SKILL.md':
        '---\nname: demo\ndescription: d\ntags: [a, b #2]\n---\nBody.\n',
    });
    assert.equal(warnings.filter((w) => w.code === 'HH-W014').length, 1);
  });

  // A clean inline array (no " #" in any item) stays warning-free.
  it('does not warn on an inline array whose items are free of " #"', async () => {
    const { warnings } = await parseFixture({
      '.agents/skills/demo/SKILL.md':
        '---\nname: demo\ndescription: d\ntags: [a, b, c]\n---\nBody.\n',
    });
    assert.deepEqual(
      warnings.filter((w) => w.code === 'HH-W014'),
      [],
    );
  });
});

describe('parseRepo \u2014 aggregated parse errors (#36)', () => {
  it('reports EVERY unparseable file in one pass instead of aborting on the first', async () => {
    // #58: " #" in a description is no longer a parse error (it warns), so the
    // unparseable fixtures use a genuine, still-rejected fault: a missing
    // `description:` key. The point of the test is aggregation across files.
    const repo = await mkTempRepo({
      'AGENTS.md': '# T\n',
      '.agents/skills/alpha/SKILL.md': '---\nname: alpha\n---\nB.\n',
      '.agents/skills/beta/SKILL.md': '---\nname: beta\n---\nB.\n',
      '.agents/instructions/ok.md': '---\nscope: "src/**"\n---\nfine\n',
    });
    try {
      await assert.rejects(
        parseRepo({ readRepo: () => readRepoSnapshot(repo.root) }),
        (err: unknown) => {
          assert.equal(err instanceof AggregateParseError, true, `got ${String(err)}`);
          const aggregate = err as AggregateParseError;
          assert.equal(aggregate.exitCode, 3);
          assert.equal(aggregate.errors.length, 2);
          assert.match(aggregate.message, /2 canonical source files failed to parse/);
          assert.match(aggregate.message, /alpha\/SKILL\.md/);
          assert.match(aggregate.message, /beta\/SKILL\.md/);
          return true;
        },
      );
    } finally {
      await repo.cleanup();
    }
  });

  it('throws the single ParseError unchanged when only one file fails', () =>
    assertParseError(
      {
        '.agents/skills/alpha/SKILL.md': '---\nname: alpha\n---\nB.\n',
        '.agents/skills/beta/SKILL.md': '---\nname: beta\ndescription: fine\n---\nB.\n',
      },
      /alpha\/SKILL\.md/,
    ));

  it('aggregates across file kinds (a bad fragment plus a bad hook)', async () => {
    const repo = await mkTempRepo({
      '.agents/instructions/frag.md': '---\nnot yaml at all\n---\nbody\n',
      '.agents/hooks/unknown-event.lint.sh': '#!/bin/sh\n',
    });
    try {
      await assert.rejects(
        parseRepo({ readRepo: () => readRepoSnapshot(repo.root) }),
        (err: unknown) => {
          assert.equal(err instanceof AggregateParseError, true, `got ${String(err)}`);
          const aggregate = err as AggregateParseError;
          assert.match(aggregate.message, /frag\.md/);
          assert.match(aggregate.message, /unknown-event\.lint\.sh/);
          return true;
        },
      );
    } finally {
      await repo.cleanup();
    }
  });
});

describe('parseRepo — HH-W011 boundaries', () => {
  it('does not warn for a lone leading --- without a closing delimiter (thematic break)', async () => {
    const content = '---\n# Standards\n\nNo closing delimiter anywhere.\n';
    const { ir, warnings } = await parseFixture({ 'AGENTS.md': content });
    assert.deepEqual(warnings, []);
    assert.equal(ir.instructions[0]?.body, content);
  });

  it('does not warn for an empty frontmatter block (---\\n---: nothing can leak)', async () => {
    const content = '---\n---\n# Standards\n';
    const { ir, warnings } = await parseFixture({ 'AGENTS.md': content });
    assert.deepEqual(warnings, []);
    assert.equal(ir.instructions[0]?.body, content);
  });
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
    assert.equal(skill?.frontmatter, 'name: deploy\ndescription: Ship the thing safely');
    assert.equal(skill?.path, '.agents/skills/deploy/SKILL.md');
    assert.equal(skill?.body, '# Deploy\n\nSteps.\n');
    assert.deepEqual(
      skill?.files.map((file) => file.path).sort(),
      ['.agents/skills/deploy/references/notes.md', '.agents/skills/deploy/scripts/run.sh'],
    );
    assert.deepEqual(warnings, []);
  });

  it('captures provider-specific frontmatter keys verbatim (#38: allowed-tools, argument-hint)', async () => {
    // name/description are still surfaced as fields, but the whole block is kept
    // verbatim so the Claude projection can reproduce every key (the canonical
    // .agents/skills/ copy is read natively by the other providers).
    const { ir } = await parseFixture({
      '.agents/skills/graphify/SKILL.md':
        '---\nname: graphify\ndescription: d\nallowed-tools: "read_file, edit_file"\nargument-hint: "<path>"\ntrigger: /graphify\n---\nBody.\n',
    });
    const skill = ir.skills[0];
    assert.equal(skill?.name, 'graphify');
    assert.equal(
      skill?.frontmatter,
      'name: graphify\ndescription: d\nallowed-tools: "read_file, edit_file"\nargument-hint: "<path>"\ntrigger: /graphify',
    );
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

describe('parseRepo — skill name validation (B2)', () => {
  it('fails with exit code 3 on a path-traversal skill name', () =>
    assertParseError(
      {
        '.agents/skills/evil/SKILL.md':
          '---\nname: ../../.github/workflows/pwn\ndescription: nope\n---\nbody\n',
      },
      /\.agents\/skills\/evil\/SKILL\.md: invalid skill name "\.\.\/\.\.\/\.github\/workflows\/pwn".*\[a-z0-9\]/,
    ));

  it('fails with exit code 3 on a YAML-breaking skill name', () =>
    assertParseError(
      {
        '.agents/skills/colon/SKILL.md':
          '---\nname: "foo: bar"\ndescription: nope\n---\nbody\n',
      },
      /invalid skill name "foo: bar"/,
    ));

  it('accepts a hyphenated alphanumeric name per the Agent Skills standard', async () => {
    const { ir } = await parseFixture({
      '.agents/skills/ok/SKILL.md':
        '---\nname: valid-skill-2\ndescription: fine\n---\nbody\n',
    });
    assert.equal(ir.skills[0]?.name, 'valid-skill-2');
  });

  it('rejects uppercase, leading/trailing, and doubled hyphens', async () => {
    for (const name of ['Deploy', '-lead', 'trail-', 'a--b']) {
      await assertParseError(
        {
          '.agents/skills/bad/SKILL.md': `---\nname: ${name}\ndescription: d\n---\nbody\n`,
        },
        /invalid skill name/,
      );
    }
  });
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

  it('lifts a hook whose name contains dots (<name> may have dot segments)', async () => {
    const { ir, warnings } = await parseFixture({
      '.agents/hooks/pre-tool-use.my.fancy.sh': 'echo hi\n',
    });
    assert.equal(ir.hooks.length, 1);
    assert.equal(ir.hooks[0]?.event, 'pre-tool-use');
    assert.equal(ir.hooks[0]?.name, 'my.fancy');
    assert.deepEqual(warnings, []);
  });

  it('fails with exit code 3 on a hook-shaped filename containing a space (B3)', () =>
    assertParseError(
      { '.agents/hooks/pre-tool-use.lint all.sh': 'echo hi\n' },
      /hook filenames are restricted to \[A-Za-z0-9\._-\] because they are embedded in provider shell commands/,
    ));

  it('fails with exit code 3 on a hook-shaped filename containing a backtick (B3)', () =>
    assertParseError(
      { '.agents/hooks/pre-tool-use.`evil`.sh': 'echo hi\n' },
      /hook filenames are restricted to/,
    ));

  it('fails with exit code 3 on a hook-shaped filename containing $( (B3)', () =>
    assertParseError(
      { '.agents/hooks/pre-tool-use.$(whoami).sh': 'echo hi\n' },
      /hook filenames are restricted to/,
    ));

  it('treats non-hook-shaped files in .agents/hooks/ as attachments with HH-W010', async () => {
    const { ir, warnings } = await parseFixture({
      // #41: `.DS_Store` is OS junk — the walk skips it BEFORE collection, so it
      // is no longer an HH-W010 attachment (it was bad advice to flag it at all).
      '.agents/hooks/.DS_Store': 'finder junk',
      '.agents/hooks/README.md': '# about these hooks\n',
      '.agents/hooks/.gitkeep': '',
      '.agents/hooks/x.toml': 'matcher = "Bash(*)"\n',
      '.agents/hooks/pre-tool-use.lint.sh.bak': 'echo old\n',
    });
    assert.deepEqual(ir.hooks, []);
    assert.deepEqual(
      ir.attachments.map((a) => a.path),
      [
        '.agents/hooks/.gitkeep',
        '.agents/hooks/README.md',
        '.agents/hooks/pre-tool-use.lint.sh.bak',
        '.agents/hooks/x.toml',
      ],
    );
    assert.equal(warnings.length, 4);
    assert.equal(warnings.every((warning) => warning.code === 'HH-W010'), true);
  });

  it('treats a trailing-dot hook filename as a non-hook-shaped attachment', async () => {
    const { ir, warnings } = await parseFixture({
      '.agents/hooks/pre-tool-use.lint.': 'echo hi\n',
    });
    assert.deepEqual(ir.hooks, []);
    assert.deepEqual(ir.attachments.map((a) => a.path), ['.agents/hooks/pre-tool-use.lint.']);
    assert.equal(warnings[0]?.code, 'HH-W010');
  });

  it('treats a two-segment hooks file (no <name>) as a non-hook-shaped attachment', async () => {
    const { ir, warnings } = await parseFixture({
      '.agents/hooks/pre-tool-use.sh': 'echo hi\n',
    });
    assert.deepEqual(ir.hooks, []);
    assert.deepEqual(ir.attachments.map((a) => a.path), ['.agents/hooks/pre-tool-use.sh']);
    assert.equal(warnings[0]?.code, 'HH-W010');
  });
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

  it('does not collect a gitignored .agents/ file into the IR but surfaces HH-W012', async () => {
    // Pre-#21 this was a silent skip; EV1 now surfaces the exclusion (a
    // canonical-shaped path under .agents/ the walk reaches was dropped) so
    // apply cannot run off an unexpectedly empty IR (PRD §16: no silent loss
    // of canonical sources the walk reaches).
    const { ir, warnings } = await parseFixture({
      '.gitignore': 'notes.txt\n',
      'AGENTS.md': '# root',
      '.agents/notes.txt': 'ignored scratch content',
    });
    assert.deepEqual(ir.attachments, []);
    assert.equal(ir.instructions.length, 1);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.code, 'HH-W012');
    assert.equal(warnings[0]?.canonicalPath, '.agents/notes.txt');
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

describe('parseRepo — HH-W012 (canonical source excluded by .gitignore)', () => {
  it('warns when *.md hides every AGENTS.md and yields an empty IR', async () => {
    const { ir, warnings } = await parseFixture({
      '.gitignore': '*.md\n',
      'AGENTS.md': '# root, ignored by *.md',
    });
    assert.deepEqual(ir.instructions, []);
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0]?.code, 'HH-W012');
    assert.equal(warnings[0]?.severity, 'warn');
    assert.equal(warnings[0]?.canonicalPath, 'AGENTS.md');
    assert.match(warnings[0]?.message ?? '', /excluded by a \.gitignore rule/);
  });

  it('does NOT warn when a negation re-includes the excluded AGENTS.md', async () => {
    const { ir, warnings } = await parseFixture({
      '.gitignore': '*.md\n!AGENTS.md\n',
      'AGENTS.md': '# root, re-included',
    });
    assert.equal(ir.instructions.length, 1);
    assert.equal(ir.instructions[0]?.path, 'AGENTS.md');
    assert.deepEqual(
      warnings.filter((w) => w.code === 'HH-W012'),
      [],
    );
  });

  it('warns with the .agents/ anchor when the whole canonical dir is ignored', async () => {
    const { warnings } = await parseFixture({
      '.gitignore': '.agents/\n',
      'AGENTS.md': '# root survives',
      '.agents/instructions/arch.md': '---\nscope: "src/**"\n---\nbody',
    });
    const w012 = warnings.filter((w) => w.code === 'HH-W012');
    assert.equal(w012.length, 1);
    assert.equal(w012[0]?.canonicalPath, '.agents/');
  });
});

// Finding 2 (#60): the parsed IR was checked, but no test followed a
// " #"-bearing scope THROUGH a projection — exactly the gap that let a broken
// literal glob reach Claude `paths:` / Copilot `applyTo:` unnoticed. These
// drive both adapters from the real parsed instruction and assert (a) the
// emitted glob carries the literal value and (b) parse did NOT stay silent.
describe('parseRepo — " #" scope projects to provider globs (and is not silent)', () => {
  it('projects a " #" scope into Claude paths: and Copilot applyTo:, with HH-W014 from parse', async () => {
    const { ir, warnings } = await parseFixture({
      'AGENTS.md': '# root\n',
      '.agents/instructions/c.md': '---\nscope: src/** # only source\n---\nGuidance.\n',
    });
    // (b) parse surfaced the ambiguity — the projection is NOT silent.
    const w14 = warnings.filter((w) => w.code === 'HH-W014');
    assert.equal(w14.length, 1, 'expected exactly one HH-W014 from parse');

    const fragment = ir.instructions.find((i) => i.path === '.agents/instructions/c.md');
    assert.ok(fragment, 'expected the scoped fragment in the IR');
    assert.equal(fragment?.scope, 'src/** # only source');

    // (a) Claude: the literal glob lands verbatim in the rule's paths: frontmatter.
    const claudeProjection = claudeAdapter.project(ir, ctxWith());
    const rule = claudeProjection.files.find(
      (f) => f.path === '.claude/rules/hh.c.md',
    );
    assert.ok(rule, 'expected a .claude/rules/hh.c.md rule file');
    assert.match(rule?.body ?? '', /paths: \["src\/\*\* # only source"\]/);

    // (a) Copilot: same literal lands in applyTo:.
    const copilotProjection = copilotAdapter.project(ir, ctxWith());
    const instr = copilotProjection.files.find(
      (f) => f.path === '.github/instructions/hh.c.instructions.md',
    );
    assert.ok(instr, 'expected a .github/instructions/hh.c.instructions.md file');
    assert.match(instr?.body ?? '', /applyTo: "src\/\*\* # only source"/);
  });
});
