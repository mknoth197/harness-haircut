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
  matcher: string;
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
            matcher: '*',
            hooks: [{ type: 'command', command: '.agents/hooks/pre-tool-use.lint.sh' }],
          },
        ],
      },
    });
    assert.equal(projection.surfaces.hooks, 'emitted');
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

  it('groups multiple hooks for one event into a single "*" matcher group, sorted by path', () => {
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
