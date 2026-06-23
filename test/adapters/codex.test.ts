import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CODEX_EVENT_MAP,
  CODEX_PROJECT_DOC_MAX_BYTES,
  codexAdapter,
  parseRepo,
  readRepoSnapshot,
} from '../../dist/index.js';
import type { HookEvent, RepoSnapshot } from '../../dist/index.js';
import { ctxWith, fragment, hook, ir, nestedInstruction, rootInstruction, skill } from '../_helpers/ir.ts';
import { mkTempRepo } from '../_helpers/tmp-repo.ts';

interface HandlerEntry {
  type: string;
  command: string;
}

interface MatcherGroup {
  /** B5: deliberately absent — omitted matcher means match-all. */
  matcher?: string;
  hooks: HandlerEntry[];
}

interface HooksDoc {
  hooks: Record<string, MatcherGroup[]>;
}

function emittedHooksDoc(body: string): HooksDoc {
  return JSON.parse(body) as HooksDoc;
}

function snapshot(files: Record<string, string>): RepoSnapshot {
  return {
    root: '/repo',
    files: Object.entries(files).map(([path, content]) => ({ path, content })),
  };
}

describe('codexAdapter — identity and native surfaces', () => {
  it('registers with id "codex" (U1)', () => {
    assert.equal(codexAdapter.id, 'codex');
  });

  it('emits no files for instructions and skills and reports both as native (U2)', () => {
    const projection = codexAdapter.project(
      ir({ instructions: [rootInstruction(), nestedInstruction('pkg/web')], skills: [skill('deploy')] }),
      ctxWith(),
    );
    assert.deepEqual(projection.files, []);
    assert.equal(projection.surfaces.instructions, 'native');
    assert.equal(projection.surfaces.skills, 'native');
  });

  it('reports the hooks surface as skipped when the IR has no hooks', () => {
    const projection = codexAdapter.project(ir(), ctxWith());
    assert.equal(projection.surfaces.hooks, 'skipped');
    assert.deepEqual(projection.warnings, []);
  });
});

describe('codexAdapter — hooks projection (EV2/EV3)', () => {
  it('emits .codex/hooks.json with the matcher/hooks schema in overwrite mode', () => {
    const projection = codexAdapter.project(ir({ hooks: [hook('pre-tool-use', 'lint')] }), ctxWith());
    assert.equal(projection.files.length, 1);
    const file = projection.files[0];
    assert.equal(file?.path, '.codex/hooks.json');
    assert.equal(file?.mode, 'overwrite');
    assert.deepEqual(emittedHooksDoc(file?.body ?? ''), {
      hooks: {
        PreToolUse: [
          {
            hooks: [{ type: 'command', command: '.agents/hooks/pre-tool-use.lint.sh' }],
          },
        ],
      },
    });
    assert.equal(projection.surfaces.hooks, 'emitted');
  });

  it('omits the matcher key — absent means match-all; "*" is undocumented for Codex (B5)', () => {
    const projection = codexAdapter.project(ir({ hooks: [hook('stop', 'notify')] }), ctxWith());
    const doc = JSON.parse(projection.files[0]?.body ?? '') as {
      hooks: Record<string, Record<string, unknown>[]>;
    };
    const group = doc.hooks['Stop']?.[0];
    assert.equal(group !== undefined && 'matcher' in group, false);
  });

  it('emits a stable thin command referencing the canonical script path, never the body (EV3)', () => {
    const script = '#!/usr/bin/env bash\nVERY_DISTINCTIVE_BODY_MARKER=1\n';
    const projection = codexAdapter.project(
      ir({ hooks: [{ event: 'stop', name: 'notify', path: '.agents/hooks/stop.notify.sh', script }] }),
      ctxWith(),
    );
    const body = projection.files[0]?.body ?? '';
    assert.match(body, /\.agents\/hooks\/stop\.notify\.sh/);
    assert.doesNotMatch(body, /VERY_DISTINCTIVE_BODY_MARKER/);
  });

  it('maps every canonical event to its Codex PascalCase name', () => {
    const events: HookEvent[] = ['session-start', 'user-prompt-submit', 'pre-compact'];
    const projection = codexAdapter.project(
      ir({ hooks: events.map((event) => hook(event, 'x')) }),
      ctxWith(),
    );
    const doc = emittedHooksDoc(projection.files[0]?.body ?? '');
    assert.deepEqual(Object.keys(doc.hooks).sort(), ['PreCompact', 'SessionStart', 'UserPromptSubmit']);
  });

  it('groups multiple hooks for one event into a single match-all group, sorted by path', () => {
    const projection = codexAdapter.project(
      ir({ hooks: [hook('pre-tool-use', 'zebra'), hook('pre-tool-use', 'alpha')] }),
      ctxWith(),
    );
    const doc = emittedHooksDoc(projection.files[0]?.body ?? '');
    const groups = doc.hooks['PreToolUse'];
    assert.equal(groups?.length, 1);
    assert.deepEqual(
      groups?.[0]?.hooks.map((entry) => entry.command),
      ['.agents/hooks/pre-tool-use.alpha.sh', '.agents/hooks/pre-tool-use.zebra.sh'],
    );
  });
});

describe('codexAdapter — unmappable events (UN1 / HH-W003)', () => {
  it('warns HH-W003 and skips a session-end hook (Codex has no such event)', () => {
    const projection = codexAdapter.project(
      ir({ hooks: [hook('session-end', 'teardown'), hook('stop', 'notify')] }),
      ctxWith(),
    );
    assert.equal(projection.warnings.length, 1);
    assert.equal(projection.warnings[0]?.code, 'HH-W003');
    assert.equal(projection.warnings[0]?.providerId, 'codex');
    assert.equal(projection.warnings[0]?.canonicalPath, '.agents/hooks/session-end.teardown.sh');
    const doc = emittedHooksDoc(projection.files[0]?.body ?? '');
    assert.deepEqual(Object.keys(doc.hooks), ['Stop']);
  });

  it('reports hooks as skipped and emits nothing when every hook is unmappable', () => {
    const projection = codexAdapter.project(ir({ hooks: [hook('session-end', 'teardown')] }), ctxWith());
    assert.deepEqual(projection.files, []);
    assert.equal(projection.surfaces.hooks, 'skipped');
    assert.equal(projection.warnings[0]?.code, 'HH-W003');
  });
});

describe('codexAdapter — 32 KiB chain cap (EV1 / HH-W004)', () => {
  it('warns HH-W004 when combined root+nested AGENTS.md content exceeds the cap', () => {
    const half = 'x'.repeat(CODEX_PROJECT_DOC_MAX_BYTES / 2 + 1);
    const projection = codexAdapter.project(
      ir({ instructions: [rootInstruction(half), nestedInstruction('pkg', half)] }),
      ctxWith(),
    );
    assert.equal(projection.warnings.length, 1);
    assert.equal(projection.warnings[0]?.code, 'HH-W004');
    assert.equal(projection.warnings[0]?.providerId, 'codex');
    assert.match(projection.warnings[0]?.message ?? '', /32768/);
  });

  it('does not warn at exactly the cap', () => {
    const projection = codexAdapter.project(
      ir({ instructions: [rootInstruction('x'.repeat(CODEX_PROJECT_DOC_MAX_BYTES))] }),
      ctxWith(),
    );
    assert.deepEqual(projection.warnings, []);
  });

  it('does not count scoped fragments toward the cap (Codex never loads .agents/instructions/)', () => {
    const projection = codexAdapter.project(
      ir({
        instructions: [
          rootInstruction('lean root\n'),
          fragment('big', 'src/**', 'y'.repeat(CODEX_PROJECT_DOC_MAX_BYTES + 1)),
        ],
      }),
      ctxWith(),
    );
    assert.deepEqual(projection.warnings, []);
  });

  // #dogfood-round2 (7): the cap is PER root→cwd chain, not a whole-repo sum.
  // Several large SIBLING nested AGENTS.md (different subtrees) whose bodies SUM
  // past the cap must NOT warn, because Codex never loads two sibling chains for
  // one working directory — only the root + the nested files on the path down to
  // a given cwd.
  it('does NOT warn when sibling AGENTS.md sum exceeds the cap but no single chain does', () => {
    // Three quarter-cap siblings + a small root. Each chain = root + ONE sibling
    // ≈ cap/4, well under the cap; the SUM (≈ 3·cap/4 + root) exceeds it.
    const quarter = 'x'.repeat(Math.floor(CODEX_PROJECT_DOC_MAX_BYTES / 4));
    const projection = codexAdapter.project(
      ir({
        instructions: [
          rootInstruction('# root\n'),
          nestedInstruction('packages/a', quarter),
          nestedInstruction('packages/b', quarter),
          nestedInstruction('packages/c', quarter),
        ],
      }),
      ctxWith(),
    );
    assert.deepEqual(projection.warnings, []);
  });

  // The deepest single chain (root → packages/a → packages/a/web) is what counts.
  it('warns for the heaviest root→cwd chain even when siblings stay light', () => {
    const big = 'x'.repeat(CODEX_PROJECT_DOC_MAX_BYTES); // root alone == cap (no warn yet)
    const overflow = 'y'.repeat(64); // any nested file on the chain tips it over
    const projection = codexAdapter.project(
      ir({
        instructions: [
          rootInstruction(big),
          // A heavy descendant chain: root + this nested = cap + 64 > cap.
          nestedInstruction('packages/a', overflow),
          // A light sibling whose own chain (root + this) also exceeds — but the
          // point is the warning fires and names a real over-cap chain size.
          nestedInstruction('packages/b', '# tiny\n'),
        ],
      }),
      ctxWith(),
    );
    assert.equal(projection.warnings.length, 1);
    assert.equal(projection.warnings[0]?.code, 'HH-W004');
    assert.equal(projection.warnings[0]?.providerId, 'codex');
    // The reported size is a real chain total, not the whole-repo sum: it must be
    // <= the sum of every AGENTS.md body (root + a + b).
    const wholeRepoSum =
      CODEX_PROJECT_DOC_MAX_BYTES + overflow.length + Buffer.byteLength('# tiny\n', 'utf8');
    const m = /(\d+) bytes/.exec(projection.warnings[0]?.message ?? '');
    assert.ok(m, 'message reports a byte count');
    const reported = Number(m![1]);
    assert.ok(reported > CODEX_PROJECT_DOC_MAX_BYTES, 'reported chain is over the cap');
    assert.ok(reported < wholeRepoSum, 'reported chain is a single chain, not the whole-repo sum');
  });

  // A deep linear chain (root → a → a/b → a/b/c) sums past the cap → warn.
  it('warns when a deep linear root→cwd chain exceeds the cap', () => {
    const third = 'z'.repeat(Math.floor(CODEX_PROJECT_DOC_MAX_BYTES / 3) + 16);
    const projection = codexAdapter.project(
      ir({
        instructions: [
          rootInstruction('# root\n'),
          nestedInstruction('a', third),
          nestedInstruction('a/b', third),
          nestedInstruction('a/b/c', third),
        ],
      }),
      ctxWith(),
    );
    assert.equal(projection.warnings.length, 1);
    assert.equal(projection.warnings[0]?.code, 'HH-W004');
  });

  // A nested AGENTS.md that is NOT an ancestor (a/b is not on x/y's chain) must
  // not contribute to x/y's chain — guards the prefix check against substring
  // false positives (e.g. "a" vs "ab").
  it('does not treat a sibling-prefixed directory as an ancestor (ab is not under a)', () => {
    const big = 'x'.repeat(CODEX_PROJECT_DOC_MAX_BYTES); // each alone == cap
    const projection = codexAdapter.project(
      ir({
        instructions: [
          rootInstruction('# root\n'),
          nestedInstruction('a', big),
          nestedInstruction('ab', big), // "ab" must NOT be seen as under "a"
        ],
      }),
      ctxWith(),
    );
    // Each chain is root(7) + cap = cap+7 > cap, so it DOES warn — but the point
    // is correctness: if "ab" were wrongly folded under "a", the chain would be
    // root + a + ab = cap*2+7. Assert the reported size is a single chain.
    assert.equal(projection.warnings[0]?.code, 'HH-W004');
    const m = /(\d+) bytes/.exec(projection.warnings[0]?.message ?? '');
    const reported = Number(m![1]);
    assert.equal(reported, CODEX_PROJECT_DOC_MAX_BYTES + Buffer.byteLength('# root\n', 'utf8'));
  });
});

describe('codexAdapter — existing [hooks] table (UN2 / HH-W005)', () => {
  it('warns HH-W005 when .codex/config.toml has a [hooks] table and hooks are emitted', () => {
    const projection = codexAdapter.project(
      ir({ hooks: [hook('stop', 'notify')] }),
      ctxWith({ '.codex/config.toml': '[features]\nhooks = true\n\n[hooks]\nfoo = "bar"\n' }),
    );
    const codes = projection.warnings.map((warning) => warning.code);
    assert.deepEqual(codes, ['HH-W005']);
    assert.match(projection.warnings[0]?.message ?? '', /\.codex\/config\.toml/);
  });

  it('does not warn when config.toml has no [hooks] table', () => {
    const projection = codexAdapter.project(
      ir({ hooks: [hook('stop', 'notify')] }),
      ctxWith({ '.codex/config.toml': '[features]\nhooks = false\n' }),
    );
    assert.deepEqual(projection.warnings, []);
  });

  it('detects whitespace and quoted-key table-header forms ([ hooks ], ["hooks"])', () => {
    for (const header of ['[ hooks ]', '["hooks"]', "['hooks']", '[ hooks . pre ]', '[[ hooks ]]']) {
      const projection = codexAdapter.project(
        ir({ hooks: [hook('stop', 'notify')] }),
        ctxWith({ '.codex/config.toml': `${header}\nfoo = "bar"\n` }),
      );
      assert.deepEqual(
        projection.warnings.map((warning) => warning.code),
        ['HH-W005'],
        `expected HH-W005 for header form ${header}`,
      );
    }
  });

  it('does not misdetect hooks-prefixed table names or key-value lines', () => {
    const projection = codexAdapter.project(
      ir({ hooks: [hook('stop', 'notify')] }),
      ctxWith({ '.codex/config.toml': '[hooks_extra]\nnote = "[hooks]"\n' }),
    );
    assert.deepEqual(projection.warnings, []);
  });

  it('does not warn when the IR has no hooks to double-define', () => {
    const projection = codexAdapter.project(
      ir(),
      ctxWith({ '.codex/config.toml': '[hooks]\nfoo = "bar"\n' }),
    );
    assert.deepEqual(projection.warnings, []);
  });
});

describe('codexAdapter.detectExisting (EV4)', () => {
  it('names AGENTS.md files, .agents/skills/, .codex/hooks.json, and a config.toml [hooks] table', () => {
    const existing = codexAdapter.detectExisting(
      snapshot({
        'AGENTS.md': '# root',
        'pkg/AGENTS.md': '# nested',
        '.agents/skills/deploy/SKILL.md': '---\nname: deploy\ndescription: d\n---\n',
        '.codex/hooks.json': '{"hooks": {}}',
        '.codex/config.toml': '[hooks]\n',
      }),
    );
    assert.deepEqual(existing, {
      providerId: 'codex',
      paths: ['AGENTS.md', 'pkg/AGENTS.md', '.agents/skills/', '.codex/hooks.json', '.codex/config.toml'],
    });
  });

  it('omits .codex/config.toml when it has no [hooks] table', () => {
    const existing = codexAdapter.detectExisting(
      snapshot({ 'AGENTS.md': '# root', '.codex/config.toml': '[features]\n' }),
    );
    assert.deepEqual(existing?.paths, ['AGENTS.md']);
  });

  it('returns null when no codex-relevant files exist', () => {
    assert.equal(codexAdapter.detectExisting(snapshot({ 'README.md': 'hi' })), null);
  });
});

describe('codexAdapter — fixture round-trip (hooks only)', () => {
  it('re-parsing emitted commands reproduces the canonical hook set', async () => {
    const repo = await mkTempRepo({
      '.agents/hooks/pre-tool-use.lint.sh': '#!/usr/bin/env bash\nnpm run lint\n',
      '.agents/hooks/stop.notify.sh': '#!/usr/bin/env bash\necho done\n',
      '.agents/hooks/session-start.env.js': '#!/usr/bin/env node\nconsole.log("hi");\n',
    });
    try {
      const { ir: parsed } = await parseRepo({ readRepo: () => readRepoSnapshot(repo.root) });
      const projection = codexAdapter.project(parsed, { cwd: repo.root });
      const doc = emittedHooksDoc(projection.files[0]?.body ?? '');

      const inverse = new Map(
        Object.entries(CODEX_EVENT_MAP).map(([canonical, provider]) => [provider, canonical]),
      );
      const roundTripped: Array<{ event: string | undefined; path: string }> = [];
      for (const [providerEvent, groups] of Object.entries(doc.hooks)) {
        for (const group of groups) {
          for (const entry of group.hooks) {
            roundTripped.push({ event: inverse.get(providerEvent), path: entry.command });
          }
        }
      }
      const byPath = (a: { path: string }, b: { path: string }) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
      assert.deepEqual(
        roundTripped.sort(byPath),
        parsed.hooks.map((h) => ({ event: h.event as string, path: h.path })).sort(byPath),
      );
    } finally {
      await repo.cleanup();
    }
  });
});
