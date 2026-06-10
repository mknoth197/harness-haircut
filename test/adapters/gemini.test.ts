import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MalformedProviderConfigError, geminiAdapter } from '../../dist/index.js';
import type { EmittedFile } from '../../dist/index.js';
import { ctxWith, fragment, hook, ir, nestedInstruction, rootInstruction, skill } from '../_helpers/ir.ts';

interface HandlerEntry {
  type: string;
  command: string;
  timeout?: number;
}

interface MatcherGroup {
  /** B5: deliberately absent — omitted matcher means match-all on every provider. */
  matcher?: string;
  hooks: HandlerEntry[];
}

function mergeFileFor(files: readonly EmittedFile[], mergeKey: string): EmittedFile | undefined {
  return files.find((file) => file.mergeKey === mergeKey);
}

describe('geminiAdapter — identity and native surfaces', () => {
  it('registers with id "gemini" (U1)', () => {
    assert.equal(geminiAdapter.id, 'gemini');
  });

  it('emits nothing for skills and reports the surface as native (EV3)', () => {
    const projection = geminiAdapter.project(ir({ skills: [skill('deploy')] }), ctxWith());
    assert.deepEqual(projection.files, []);
    assert.equal(projection.surfaces.skills, 'native');
  });
});

describe('geminiAdapter — settings mode instructions (EV1/EV5)', () => {
  it('writes context.fileName ["AGENTS.md", "GEMINI.md"] as merge-key when no settings exist', () => {
    const projection = geminiAdapter.project(ir({ instructions: [rootInstruction()] }), ctxWith());
    const file = mergeFileFor(projection.files, 'context.fileName');
    assert.equal(file?.path, '.gemini/settings.json');
    assert.equal(file?.mode, 'merge-key');
    assert.deepEqual(JSON.parse(file?.body ?? ''), ['AGENTS.md', 'GEMINI.md']);
    assert.equal(projection.surfaces.instructions, 'merged');
  });

  it('promotes an existing string value to an array and preserves it (EV5)', () => {
    const projection = geminiAdapter.project(
      ir({ instructions: [rootInstruction()] }),
      ctxWith({ '.gemini/settings.json': '{"context": {"fileName": "CONTEXT.md"}}' }),
    );
    const file = mergeFileFor(projection.files, 'context.fileName');
    assert.deepEqual(JSON.parse(file?.body ?? ''), ['AGENTS.md', 'CONTEXT.md']);
  });

  it('merges into an existing array without duplicating AGENTS.md', () => {
    const projection = geminiAdapter.project(
      ir({ instructions: [rootInstruction()] }),
      ctxWith({ '.gemini/settings.json': '{"context": {"fileName": ["AGENTS.md", "GEMINI.md"]}}' }),
    );
    const file = mergeFileFor(projection.files, 'context.fileName');
    assert.deepEqual(JSON.parse(file?.body ?? ''), ['AGENTS.md', 'GEMINI.md']);
  });

  it('targets only the owned key — foreign settings keys are never part of the emit', () => {
    const projection = geminiAdapter.project(
      ir({ instructions: [rootInstruction()] }),
      ctxWith({
        '.gemini/settings.json':
          '{"mcpServers": {"db": {}}, "telemetry": {"enabled": false}, "context": {"fileName": "GEMINI.md"}}',
      }),
    );
    assert.equal(projection.files.length, 1);
    assert.equal(projection.files[0]?.mode, 'merge-key');
    assert.equal(projection.files[0]?.mergeKey, 'context.fileName');
    assert.deepEqual(JSON.parse(projection.files[0]?.body ?? ''), ['AGENTS.md', 'GEMINI.md']);
  });

  it('skips the instructions surface when the IR has no AGENTS.md content', () => {
    const projection = geminiAdapter.project(ir(), ctxWith());
    assert.deepEqual(projection.files, []);
    assert.equal(projection.surfaces.instructions, 'skipped');
  });
});

describe('geminiAdapter — shim mode (EV2)', () => {
  const shimConfig = { mode: 'shim' };

  it('emits a GEMINI.md @AGENTS.md import shim with no SignedSource header', () => {
    const projection = geminiAdapter.project(
      ir({ instructions: [rootInstruction()] }),
      ctxWith({}, shimConfig),
    );
    assert.deepEqual(projection.files, [
      { path: 'GEMINI.md', body: '@AGENTS.md\n', mode: 'overwrite' },
    ]);
    assert.equal(projection.surfaces.instructions, 'emitted');
  });

  it('emits nested GEMINI.md shims for nested AGENTS.md directories', () => {
    const projection = geminiAdapter.project(
      ir({ instructions: [rootInstruction(), nestedInstruction('pkg/web')] }),
      ctxWith({}, shimConfig),
    );
    assert.deepEqual(
      projection.files.map((file) => file.path),
      ['GEMINI.md', 'pkg/web/GEMINI.md'],
    );
  });

  it('leaves an existing correct shim alone and reports merged', () => {
    const projection = geminiAdapter.project(
      ir({ instructions: [rootInstruction()] }),
      ctxWith({ 'GEMINI.md': '@AGENTS.md\n\nuser notes\n' }, shimConfig),
    );
    assert.deepEqual(projection.files, []);
    assert.equal(projection.surfaces.instructions, 'merged');
  });

  it('warns HH-W005 and skips when an existing GEMINI.md is not the import shim', () => {
    const projection = geminiAdapter.project(
      ir({ instructions: [rootInstruction()] }),
      ctxWith({ 'GEMINI.md': '# Hand-written Gemini context\n' }, shimConfig),
    );
    assert.deepEqual(projection.files, []);
    assert.equal(projection.warnings[0]?.code, 'HH-W005');
    assert.match(projection.warnings[0]?.message ?? '', /^GEMINI\.md exists/);
    assert.equal(projection.surfaces.instructions, 'skipped');
  });
});

describe('geminiAdapter — hooks (EV4/OPT1)', () => {
  it('writes the hooks merge-key with Gemini Before/After event names', () => {
    const projection = geminiAdapter.project(
      ir({
        hooks: [
          hook('pre-tool-use', 'lint'),
          hook('post-tool-use', 'fmt'),
          hook('user-prompt-submit', 'log'),
          hook('stop', 'notify'),
          hook('pre-compact', 'save'),
        ],
      }),
      ctxWith(),
    );
    const file = mergeFileFor(projection.files, 'hooks');
    assert.equal(file?.path, '.gemini/settings.json');
    assert.equal(file?.mode, 'merge-key');
    const groups = JSON.parse(file?.body ?? '') as Record<string, MatcherGroup[]>;
    assert.deepEqual(Object.keys(groups).sort(), [
      'AfterAgent',
      'AfterTool',
      'BeforeAgent',
      'BeforeTool',
      'PreCompress',
    ]);
    assert.deepEqual(groups['BeforeTool'], [
      { hooks: [{ type: 'command', command: '.agents/hooks/pre-tool-use.lint.sh' }] },
    ]);
    assert.equal(projection.surfaces.hooks, 'merged');
  });

  it('omits the matcher key entirely — absent means match-all; "*" is undocumented for Gemini (B5)', () => {
    const projection = geminiAdapter.project(ir({ hooks: [hook('stop', 'notify')] }), ctxWith());
    const groups = JSON.parse(mergeFileFor(projection.files, 'hooks')?.body ?? '') as Record<
      string,
      Record<string, unknown>[]
    >;
    assert.equal(groups['AfterAgent']?.[0] !== undefined && 'matcher' in (groups['AfterAgent'][0] ?? {}), false);
  });

  it('omits the timeout field — canonical hook metadata carries none (ms conversion deferred)', () => {
    const projection = geminiAdapter.project(ir({ hooks: [hook('stop', 'notify')] }), ctxWith());
    const groups = JSON.parse(mergeFileFor(projection.files, 'hooks')?.body ?? '') as Record<
      string,
      MatcherGroup[]
    >;
    const entry = groups['AfterAgent']?.[0]?.hooks[0];
    assert.deepEqual(entry, { type: 'command', command: '.agents/hooks/stop.notify.sh' });
    assert.equal(entry !== undefined && 'timeout' in entry, false);
  });

  it('warns HH-W003 and skips subagent-start/subagent-stop hooks (OPT1)', () => {
    const projection = geminiAdapter.project(
      ir({ hooks: [hook('subagent-start', 'track'), hook('subagent-stop', 'untrack'), hook('stop', 'ok')] }),
      ctxWith(),
    );
    const w003 = projection.warnings.filter((warning) => warning.code === 'HH-W003');
    assert.equal(w003.length, 2);
    assert.deepEqual(
      w003.map((warning) => warning.canonicalPath),
      ['.agents/hooks/subagent-start.track.sh', '.agents/hooks/subagent-stop.untrack.sh'],
    );
    const groups = JSON.parse(mergeFileFor(projection.files, 'hooks')?.body ?? '') as Record<
      string,
      MatcherGroup[]
    >;
    assert.deepEqual(Object.keys(groups), ['AfterAgent']);
  });

  it('reports hooks skipped with no emit when every hook is unmappable', () => {
    const projection = geminiAdapter.project(ir({ hooks: [hook('subagent-start', 'track')] }), ctxWith());
    assert.deepEqual(projection.files, []);
    assert.equal(projection.surfaces.hooks, 'skipped');
  });
});

describe('geminiAdapter — scoped fragments are unrepresentable (B1 / HH-W007)', () => {
  it('warns HH-W007 per fragment with canonicalPath and providerId in settings mode', () => {
    const projection = geminiAdapter.project(
      ir({
        instructions: [
          fragment('testing', 'test/**/*.ts'),
          fragment('arch', 'src/**'),
        ],
      }),
      ctxWith(),
    );
    assert.deepEqual(projection.files, []);
    const w007 = projection.warnings.filter((warning) => warning.code === 'HH-W007');
    assert.equal(w007.length, 2);
    assert.deepEqual(
      w007.map((warning) => warning.canonicalPath),
      ['.agents/instructions/arch.md', '.agents/instructions/testing.md'],
    );
    assert.equal(w007[0]?.providerId, 'gemini');
    assert.equal(w007[0]?.severity, 'warn');
    assert.match(w007[0]?.message ?? '', /no path-scoping mechanism/);
    assert.match(w007[1]?.message ?? '', /\.agents\/instructions\/testing\.md/);
    // Surface status logic is unchanged: no AGENTS.md content → skipped.
    assert.equal(projection.surfaces.instructions, 'skipped');
  });

  it('warns HH-W007 alongside the context.fileName merge emit when AGENTS.md is also present', () => {
    const projection = geminiAdapter.project(
      ir({ instructions: [rootInstruction(), fragment('testing', 'test/**/*.ts')] }),
      ctxWith(),
    );
    assert.equal(mergeFileFor(projection.files, 'context.fileName')?.path, '.gemini/settings.json');
    assert.equal(projection.surfaces.instructions, 'merged');
    const w007 = projection.warnings.filter((warning) => warning.code === 'HH-W007');
    assert.equal(w007.length, 1);
    assert.equal(w007[0]?.canonicalPath, '.agents/instructions/testing.md');
  });

  it('warns HH-W007 in shim mode too (the gap is mode-independent)', () => {
    const projection = geminiAdapter.project(
      ir({ instructions: [rootInstruction(), fragment('testing', 'test/**/*.ts')] }),
      ctxWith({}, { mode: 'shim' }),
    );
    assert.deepEqual(projection.files.map((file) => file.path), ['GEMINI.md']);
    const w007 = projection.warnings.filter((warning) => warning.code === 'HH-W007');
    assert.equal(w007.length, 1);
    assert.equal(w007[0]?.canonicalPath, '.agents/instructions/testing.md');
  });
});

describe('geminiAdapter — existing settings handling (UN1/UN2)', () => {
  it('throws MalformedProviderConfigError when settings.json is malformed JSON (UN1)', () => {
    assert.throws(
      () =>
        geminiAdapter.project(
          ir({ instructions: [rootInstruction()] }),
          ctxWith({ '.gemini/settings.json': '{oops' }),
        ),
      (err: unknown) => {
        assert.equal(err instanceof MalformedProviderConfigError, true);
        const domainErr = err as MalformedProviderConfigError;
        assert.equal(domainErr.exitCode, 3);
        assert.match(domainErr.message, /\.gemini\/settings\.json/);
        return true;
      },
    );
  });

  it('tolerates malformed settings when nothing targets the file (shim mode, no hooks)', () => {
    const projection = geminiAdapter.project(
      ir({ instructions: [rootInstruction()] }),
      ctxWith({ '.gemini/settings.json': '{oops' }, { mode: 'shim' }),
    );
    assert.equal(projection.files[0]?.path, 'GEMINI.md');
  });

  it('warns HH-W006 once when the legacy flat contextFileName key is present (UN2)', () => {
    const projection = geminiAdapter.project(
      ir({ instructions: [rootInstruction()], hooks: [hook('stop', 'notify')] }),
      ctxWith({ '.gemini/settings.json': '{"contextFileName": "GEMINI.md"}' }),
    );
    const w006 = projection.warnings.filter((warning) => warning.code === 'HH-W006');
    assert.equal(w006.length, 1);
    assert.match(w006[0]?.message ?? '', /contextFileName/);
    // Only the nested v2 key is written.
    assert.equal(mergeFileFor(projection.files, 'context.fileName')?.mergeKey, 'context.fileName');
  });

  it('does not warn HH-W006 when the legacy key is absent', () => {
    const projection = geminiAdapter.project(
      ir({ instructions: [rootInstruction()] }),
      ctxWith({ '.gemini/settings.json': '{"context": {"fileName": "GEMINI.md"}}' }),
    );
    assert.deepEqual(projection.warnings, []);
  });
});

describe('geminiAdapter.detectExisting', () => {
  it('names GEMINI.md files and .gemini/settings.json', () => {
    const existing = geminiAdapter.detectExisting({
      root: '/repo',
      files: [
        { path: 'GEMINI.md', content: '@AGENTS.md\n' },
        { path: 'pkg/GEMINI.md', content: 'x' },
        { path: '.gemini/settings.json', content: '{}' },
      ],
    });
    assert.deepEqual(existing, {
      providerId: 'gemini',
      paths: ['GEMINI.md', 'pkg/GEMINI.md', '.gemini/settings.json'],
    });
  });

  it('returns null when no gemini-owned files exist', () => {
    assert.equal(geminiAdapter.detectExisting({ root: '/repo', files: [] }), null);
  });
});
