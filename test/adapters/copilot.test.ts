import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  COPILOT_HOOK_NOTES,
  COPILOT_HOOKS_PATH,
  EmitPathCollisionError,
  copilotAdapter,
} from '../../dist/index.js';
import type { EmittedFile } from '../../dist/index.js';
import { ctxWith, fragment, hook, ir, nestedInstruction, rootInstruction, skill } from '../_helpers/ir.ts';

const HEADER_RE = /^<!-- @generated SignedSource<<<[0-9a-f]{16}\.[0-9a-f]{16}>>> harness-haircut DO NOT EDIT -->$/;

interface CopilotHookEntry {
  type: string;
  bash: string;
  powershell: string;
}

interface CopilotHooksDoc {
  version: number;
  hooks: Record<string, CopilotHookEntry[]>;
}

function fileAt(files: readonly EmittedFile[], path: string): EmittedFile | undefined {
  return files.find((file) => file.path === path);
}

describe('copilotAdapter — identity and native surfaces', () => {
  it('registers with id "copilot" (U1)', () => {
    assert.equal(copilotAdapter.id, 'copilot');
  });

  it('emits nothing for skills and reports the surface as native (EV3)', () => {
    const projection = copilotAdapter.project(ir({ skills: [skill('deploy')] }), ctxWith());
    assert.deepEqual(projection.files, []);
    assert.equal(projection.surfaces.skills, 'native');
  });
});

describe('copilotAdapter — root instruction (EV1)', () => {
  it('emits .github/copilot-instructions.md with header first, then the code-review rationale comment', () => {
    const projection = copilotAdapter.project(
      ir({ instructions: [rootInstruction('# Standards\n\nBe kind.\n')] }),
      ctxWith(),
    );
    const file = fileAt(projection.files, '.github/copilot-instructions.md');
    assert.equal(file?.mode, 'overwrite');
    const lines = (file?.body ?? '').split('\n');
    assert.match(lines[0] ?? '', HEADER_RE);
    assert.match(lines[1] ?? '', /^<!-- This file exists for Copilot code review/);
    assert.match(lines[1] ?? '', /AGENTS\.md is the authoritative source/);
    assert.equal(lines.slice(3).join('\n'), '# Standards\n\nBe kind.\n');
    assert.equal(projection.surfaces.instructions, 'emitted');
  });
});

describe('copilotAdapter — scoped fragments (EV2)', () => {
  it('emits .github/instructions/hh.<name>.instructions.md with applyTo frontmatter and post-frontmatter header', () => {
    const projection = copilotAdapter.project(
      ir({ instructions: [fragment('testing', 'test/**/*.ts', '# Testing\n')] }),
      ctxWith(),
    );
    const file = fileAt(projection.files, '.github/instructions/hh.testing.instructions.md');
    assert.equal(file?.mode, 'overwrite');
    const lines = (file?.body ?? '').split('\n');
    assert.equal(lines[0], '---');
    assert.equal(lines[1], 'applyTo: "test/**/*.ts"');
    assert.equal(lines[2], '---');
    assert.match(lines[3] ?? '', HEADER_RE);
    assert.equal(lines.slice(4).join('\n'), '# Testing\n');
  });
});

describe('copilotAdapter — nested AGENTS.md coverage for code review (EV2b)', () => {
  it('emits hh.nested-<dir-with-dashes>.instructions.md with a subtree applyTo glob', () => {
    const projection = copilotAdapter.project(
      ir({ instructions: [nestedInstruction('pkg/web', '# Web rules\n')] }),
      ctxWith(),
    );
    const file = fileAt(projection.files, '.github/instructions/hh.nested-pkg-web.instructions.md');
    const lines = (file?.body ?? '').split('\n');
    assert.equal(lines[1], 'applyTo: "pkg/web/**"');
    assert.equal(lines.slice(4).join('\n'), '# Web rules\n');
  });
});

describe('copilotAdapter — filename collisions (UN1)', () => {
  it('throws EmitPathCollisionError naming both sources before emit', () => {
    assert.throws(
      () =>
        copilotAdapter.project(
          ir({
            instructions: [
              nestedInstruction('pkg/web'),
              fragment('nested-pkg-web', 'pkg/web/**'),
            ],
          }),
          ctxWith(),
        ),
      (err: unknown) => {
        assert.equal(err instanceof EmitPathCollisionError, true);
        const collision = err as EmitPathCollisionError;
        assert.equal(collision.exitCode, 3);
        assert.equal(collision.targetPath, '.github/instructions/hh.nested-pkg-web.instructions.md');
        assert.deepEqual(
          [...collision.sourcePaths].sort(),
          ['.agents/instructions/nested-pkg-web.md', 'pkg/web/AGENTS.md'],
        );
        return true;
      },
    );
  });

  it('detects collisions between nested directories whose dash-flattened names coincide', () => {
    assert.throws(
      () =>
        copilotAdapter.project(
          ir({ instructions: [nestedInstruction('a/b'), nestedInstruction('a-b')] }),
          ctxWith(),
        ),
      EmitPathCollisionError,
    );
  });
});

describe('copilotAdapter — lossy applyTo globs (OPT1 / HH-W001)', () => {
  it('expands brace globs into comma-separated applyTo entries and warns', () => {
    const projection = copilotAdapter.project(
      ir({ instructions: [fragment('web', 'src/**/*.{ts,tsx}')] }),
      ctxWith(),
    );
    assert.equal(projection.warnings.length, 1);
    assert.equal(projection.warnings[0]?.code, 'HH-W001');
    assert.match(projection.warnings[0]?.message ?? '', /src\/\*\*\/\*\.ts, src\/\*\*\/\*\.tsx/);
    const file = fileAt(projection.files, '.github/instructions/hh.web.instructions.md');
    assert.match(file?.body ?? '', /applyTo: "src\/\*\*\/\*\.ts, src\/\*\*\/\*\.tsx"/);
  });

  it('downgrades a negated glob to "**" and warns', () => {
    const projection = copilotAdapter.project(
      ir({ instructions: [fragment('no-vendor', '!vendor/**')] }),
      ctxWith(),
    );
    assert.equal(projection.warnings[0]?.code, 'HH-W001');
    assert.match(projection.warnings[0]?.message ?? '', /negation/);
    assert.match(
      fileAt(projection.files, '.github/instructions/hh.no-vendor.instructions.md')?.body ?? '',
      /applyTo: "\*\*"/,
    );
  });

  it('passes plain globs through without warning', () => {
    const projection = copilotAdapter.project(
      ir({ instructions: [fragment('api', 'src/api/**')] }),
      ctxWith(),
    );
    assert.deepEqual(projection.warnings, []);
  });
});

describe('copilotAdapter — hooks (EV4/OPT2/UN2)', () => {
  it('emits .github/hooks/harness-haircut.json with version 1, camelCase events, and bash/powershell pairs', () => {
    const projection = copilotAdapter.project(
      ir({ hooks: [hook('pre-tool-use', 'lint'), hook('stop', 'notify')] }),
      ctxWith(),
    );
    const file = fileAt(projection.files, COPILOT_HOOKS_PATH);
    assert.equal(file?.mode, 'overwrite');
    const doc = JSON.parse(file?.body ?? '') as CopilotHooksDoc;
    assert.equal(doc.version, 1);
    assert.deepEqual(Object.keys(doc.hooks).sort(), ['agentStop', 'preToolUse']);
    assert.deepEqual(doc.hooks['preToolUse'], [
      {
        type: 'command',
        bash: '.agents/hooks/pre-tool-use.lint.sh',
        powershell: '.agents/hooks/pre-tool-use.lint.sh',
      },
    ]);
    assert.equal(projection.surfaces.hooks, 'emitted');
  });

  it('maps all nine canonical events — the Copilot table has no gaps, so HH-W003 never fires (OPT2)', () => {
    const projection = copilotAdapter.project(
      ir({
        hooks: [
          hook('session-start', 'a'),
          hook('session-end', 'b'),
          hook('user-prompt-submit', 'c'),
          hook('pre-tool-use', 'd'),
          hook('post-tool-use', 'e'),
          hook('stop', 'f'),
          hook('subagent-start', 'g'),
          hook('subagent-stop', 'h'),
          hook('pre-compact', 'i'),
        ],
      }),
      ctxWith(),
    );
    assert.deepEqual(projection.warnings, []);
    const doc = JSON.parse(fileAt(projection.files, COPILOT_HOOKS_PATH)?.body ?? '') as CopilotHooksDoc;
    assert.deepEqual(Object.keys(doc.hooks).sort(), [
      'agentStop',
      'postToolUse',
      'preCompact',
      'preToolUse',
      'sessionEnd',
      'sessionStart',
      'subagentStart',
      'subagentStop',
      'userPromptSubmitted',
    ]);
  });

  it('reports hooks skipped when the IR has none', () => {
    const projection = copilotAdapter.project(ir(), ctxWith());
    assert.equal(projection.surfaces.hooks, 'skipped');
  });

  it('exports the default-branch and fail-closed notes for the C-series to surface (UN2/OPT2)', () => {
    assert.match(COPILOT_HOOK_NOTES.defaultBranchOnly, /default branch/);
    assert.match(COPILOT_HOOK_NOTES.preToolUseFailClosed, /fail-closed/);
  });
});

describe('copilotAdapter.detectExisting', () => {
  it('names copilot-instructions.md, .instructions.md files, and .github/hooks JSON files', () => {
    const existing = copilotAdapter.detectExisting({
      root: '/repo',
      files: [
        { path: '.github/copilot-instructions.md', content: 'x' },
        { path: '.github/instructions/api.instructions.md', content: 'x' },
        { path: '.github/hooks/harness-haircut.json', content: '{}' },
        { path: '.github/workflows/ci.yml', content: 'x' },
      ],
    });
    assert.deepEqual(existing, {
      providerId: 'copilot',
      paths: [
        '.github/copilot-instructions.md',
        '.github/hooks/harness-haircut.json',
        '.github/instructions/api.instructions.md',
      ],
    });
  });

  it('returns null when no copilot-owned files exist', () => {
    assert.equal(copilotAdapter.detectExisting({ root: '/repo', files: [] }), null);
  });
});
