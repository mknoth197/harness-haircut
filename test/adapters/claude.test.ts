import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  EmitPathCollisionError,
  MalformedProviderConfigError,
  claudeAdapter,
  parseRepo,
  readRepoSnapshot,
} from '../../dist/index.js';
import type { EmittedFile, RepoSnapshot } from '../../dist/index.js';
import { ctxWith, fragment, hook, ir, nestedInstruction, rootInstruction, skill } from '../_helpers/ir.ts';
import { mkTempRepo } from '../_helpers/tmp-repo.ts';

const HEADER_RE = /^<!-- @generated SignedSource<<<[0-9a-f]{16}\.[0-9a-f]{16}>>> harness-haircut DO NOT EDIT -->$/;

interface HandlerEntry {
  type: string;
  command: string;
}

interface MatcherGroup {
  /** B5: deliberately absent — omitted matcher means match-all. */
  matcher?: string;
  hooks: HandlerEntry[];
}

function hooksGroups(body: string): Record<string, MatcherGroup[]> {
  return JSON.parse(body) as Record<string, MatcherGroup[]>;
}

function fileAt(files: readonly EmittedFile[], path: string): EmittedFile | undefined {
  return files.find((file) => file.path === path);
}

describe('claudeAdapter — identity', () => {
  it('registers with id "claude" (U1)', () => {
    assert.equal(claudeAdapter.id, 'claude');
  });

  it('reports all surfaces as skipped for an empty IR', () => {
    const projection = claudeAdapter.project(ir(), ctxWith());
    assert.deepEqual(projection.files, []);
    assert.deepEqual(projection.surfaces, { instructions: 'skipped', skills: 'skipped', hooks: 'skipped' });
  });
});

describe('claudeAdapter — CLAUDE.md import shim (EV1/UN2)', () => {
  it('emits a one-line @AGENTS.md shim with no SignedSource header when no CLAUDE.md exists', () => {
    const projection = claudeAdapter.project(ir({ instructions: [rootInstruction()] }), ctxWith({}));
    assert.equal(projection.files.length, 1);
    assert.deepEqual(projection.files[0], {
      path: 'CLAUDE.md',
      body: '@AGENTS.md\n',
      mode: 'overwrite',
    });
    assert.equal(projection.surfaces.instructions, 'emitted');
  });

  it('emits the shim when no provider-file reader is supplied (treated as an empty repo)', () => {
    const projection = claudeAdapter.project(ir({ instructions: [rootInstruction()] }), ctxWith());
    assert.equal(projection.files[0]?.path, 'CLAUDE.md');
  });

  it('emits nothing when CLAUDE.md already starts with the import — user content below stays preserved', () => {
    const projection = claudeAdapter.project(
      ir({ instructions: [rootInstruction()] }),
      ctxWith({ 'CLAUDE.md': '@AGENTS.md\n\nClaude-specific notes the user owns.\n' }),
    );
    assert.deepEqual(projection.files, []);
    assert.deepEqual(projection.warnings, []);
    assert.equal(projection.surfaces.instructions, 'merged');
  });

  it('warns HH-W005 and skips when an existing CLAUDE.md does not begin with the import (UN2)', () => {
    const projection = claudeAdapter.project(
      ir({ instructions: [rootInstruction()] }),
      ctxWith({ 'CLAUDE.md': '# Hand-written instructions\n\nUse pnpm.\n' }),
    );
    assert.deepEqual(projection.files, []);
    assert.equal(projection.warnings.length, 1);
    assert.equal(projection.warnings[0]?.code, 'HH-W005');
    assert.equal(projection.warnings[0]?.providerId, 'claude');
    assert.match(projection.warnings[0]?.message ?? '', /^CLAUDE\.md exists/);
    assert.equal(projection.surfaces.instructions, 'skipped');
  });

  it('treats an empty or whitespace-only CLAUDE.md as absent and emits the shim', () => {
    for (const existing of ['', '\n', '  \n\t\n']) {
      const projection = claudeAdapter.project(
        ir({ instructions: [rootInstruction()] }),
        ctxWith({ 'CLAUDE.md': existing }),
      );
      assert.deepEqual(projection.files, [
        { path: 'CLAUDE.md', body: '@AGENTS.md\n', mode: 'overwrite' },
      ]);
      assert.deepEqual(projection.warnings, []);
      assert.equal(projection.surfaces.instructions, 'emitted');
    }
  });

  it('strips a leading UTF-8 BOM before the first-line check (BOM shim is merged, not conflicting)', () => {
    const projection = claudeAdapter.project(
      ir({ instructions: [rootInstruction()] }),
      ctxWith({ 'CLAUDE.md': '\uFEFF@AGENTS.md\n\nuser notes\n' }),
    );
    assert.deepEqual(projection.files, []);
    assert.deepEqual(projection.warnings, []);
    assert.equal(projection.surfaces.instructions, 'merged');
  });
});

describe('claudeAdapter — nested shims (EV3)', () => {
  it('emits one nested CLAUDE.md shim per nested AGENTS.md directory', () => {
    const projection = claudeAdapter.project(
      ir({ instructions: [rootInstruction(), nestedInstruction('pkg/web')] }),
      ctxWith({}),
    );
    assert.deepEqual(
      projection.files.map((file) => file.path),
      ['CLAUDE.md', 'pkg/web/CLAUDE.md'],
    );
    assert.equal(projection.files[1]?.body, '@AGENTS.md\n');
  });

  it('applies the same exists/conflict rules per nested directory', () => {
    const projection = claudeAdapter.project(
      ir({ instructions: [rootInstruction(), nestedInstruction('pkg/web'), nestedInstruction('pkg/api')] }),
      ctxWith({
        'CLAUDE.md': '@AGENTS.md\n',
        'pkg/api/CLAUDE.md': 'totally different content\n',
      }),
    );
    // root: merged; pkg/api: conflict; pkg/web: emitted.
    assert.deepEqual(
      projection.files.map((file) => file.path),
      ['pkg/web/CLAUDE.md'],
    );
    assert.equal(projection.warnings[0]?.code, 'HH-W005');
    assert.match(projection.warnings[0]?.message ?? '', /pkg\/api\/CLAUDE\.md/);
    assert.equal(projection.surfaces.instructions, 'emitted');
  });
});

describe('claudeAdapter — scoped fragments → .claude/rules (EV2/OPT1)', () => {
  it('emits .claude/rules/hh.<name>.md with paths: frontmatter and the header after the frontmatter', () => {
    const projection = claudeAdapter.project(
      ir({ instructions: [fragment('testing', 'test/**/*.ts', '# Testing rules\n')] }),
      ctxWith(),
    );
    const file = fileAt(projection.files, '.claude/rules/hh.testing.md');
    assert.equal(file?.mode, 'overwrite');
    const lines = (file?.body ?? '').split('\n');
    assert.equal(lines[0], '---');
    assert.equal(lines[1], 'paths: ["test/**/*.ts"]');
    assert.equal(lines[2], '---');
    assert.match(lines[3] ?? '', HEADER_RE);
    assert.equal(lines.slice(4).join('\n'), '# Testing rules\n');
  });

  it('keeps brace expansion in paths: globs without warning (supported by Claude)', () => {
    const projection = claudeAdapter.project(
      ir({ instructions: [fragment('web', 'src/**/*.{ts,tsx}')] }),
      ctxWith(),
    );
    assert.deepEqual(projection.warnings, []);
    assert.match(projection.files[0]?.body ?? '', /paths: \["src\/\*\*\/\*\.\{ts,tsx\}"\]/);
  });

  it('warns HH-W001 and downgrades a regex-like glob to "**" (OPT1)', () => {
    const projection = claudeAdapter.project(
      ir({ instructions: [fragment('odd', 'src/(api|web)/**')] }),
      ctxWith(),
    );
    assert.equal(projection.warnings.length, 1);
    assert.equal(projection.warnings[0]?.code, 'HH-W001');
    assert.equal(projection.warnings[0]?.canonicalPath, '.agents/instructions/odd.md');
    assert.match(projection.warnings[0]?.message ?? '', /downgraded to "\*\*"/);
    assert.match(projection.files[0]?.body ?? '', /paths: \["\*\*"\]/);
  });

  it('warns HH-W001 and downgrades a negated glob to "**" (B6)', () => {
    const projection = claudeAdapter.project(
      ir({ instructions: [fragment('no-vendor', '!vendor/**')] }),
      ctxWith(),
    );
    assert.equal(projection.warnings.length, 1);
    assert.equal(projection.warnings[0]?.code, 'HH-W001');
    assert.equal(projection.warnings[0]?.providerId, 'claude');
    assert.match(projection.warnings[0]?.message ?? '', /negation/);
    assert.match(projection.files[0]?.body ?? '', /paths: \["\*\*"\]/);
  });

  it('names the loss in an HTML comment right after the header line (PRD §11 step 2)', () => {
    const projection = claudeAdapter.project(
      ir({ instructions: [fragment('no-vendor', '!vendor/**', '# Body\n')] }),
      ctxWith(),
    );
    const lines = (projection.files[0]?.body ?? '').split('\n');
    assert.match(lines[3] ?? '', HEADER_RE);
    assert.equal(
      lines[4],
      '<!-- harness-haircut: glob downgraded from "!vendor/**" (HH-W001) -->',
    );
    assert.equal(lines.slice(5).join('\n'), '# Body\n');
  });

  it('passes parenthesized path segments through unwarned (legal in real paths)', () => {
    const projection = claudeAdapter.project(
      ir({ instructions: [fragment('marketing', 'app/(marketing)/**')] }),
      ctxWith(),
    );
    assert.deepEqual(projection.warnings, []);
    assert.match(projection.files[0]?.body ?? '', /paths: \["app\/\(marketing\)\/\*\*"\]/);
  });
});

describe('claudeAdapter — skills → .claude/skills (EV4)', () => {
  it('emits SKILL.md with the canonical frontmatter and the header after the frontmatter', () => {
    const projection = claudeAdapter.project(ir({ skills: [skill('deploy')] }), ctxWith());
    const file = fileAt(projection.files, '.claude/skills/deploy/SKILL.md');
    const lines = (file?.body ?? '').split('\n');
    assert.equal(lines[0], '---');
    assert.equal(lines[1], 'name: deploy');
    assert.equal(lines[2], 'description: "Use when working with deploy"');
    assert.equal(lines[3], '---');
    assert.match(lines[4] ?? '', HEADER_RE);
    assert.equal(lines.slice(5).join('\n'), '# deploy\n\nDo the thing.\n');
    assert.equal(projection.surfaces.skills, 'emitted');
  });

  it('preserves provider-specific frontmatter keys verbatim (#38: allowed-tools, argument-hint, trigger)', () => {
    // Dropping these silently loosened the skill's tool restrictions; the Claude
    // projection must carry every canonical key through, not just name/description.
    const extras = ['allowed-tools: "Read, Edit"', 'argument-hint: "<path>"', 'trigger: /deploy'];
    const projection = claudeAdapter.project(
      ir({ skills: [skill('deploy', [], '', extras)] }),
      ctxWith(),
    );
    const file = fileAt(projection.files, '.claude/skills/deploy/SKILL.md');
    const body = file?.body ?? '';
    // The frontmatter block (before the after-frontmatter header) holds them all.
    const fence = body.indexOf('\n---\n');
    const frontmatter = body.slice(0, fence);
    assert.match(frontmatter, /^name: deploy$/m);
    assert.match(frontmatter, /^allowed-tools: "Read, Edit"$/m);
    assert.match(frontmatter, /^argument-hint: "<path>"$/m);
    assert.match(frontmatter, /^trigger: \/deploy$/m);
  });

  it('copies sibling attachments verbatim (no header — a header would corrupt scripts/assets)', () => {
    const script = '#!/usr/bin/env bash\nset -euo pipefail\n';
    const projection = claudeAdapter.project(
      ir({
        skills: [
          skill('deploy', [{ path: '.agents/skills/deploy/scripts/run.sh', content: script }]),
        ],
      }),
      ctxWith(),
    );
    const copy = fileAt(projection.files, '.claude/skills/deploy/scripts/run.sh');
    assert.equal(copy?.body, script);
    assert.equal(copy?.mode, 'overwrite');
  });

  it('throws EmitPathCollisionError when flattened attachment paths collide (unreachable via parseRepo)', () => {
    // Only hand-constructed IR can hold attachments outside the skill folder,
    // which is what forces the basename fallback into a collision.
    assert.throws(
      () =>
        claudeAdapter.project(
          ir({
            skills: [
              skill('deploy', [
                { path: 'elsewhere/a/run.sh', content: 'a' },
                { path: 'elsewhere/b/run.sh', content: 'b' },
              ]),
            ],
          }),
          ctxWith(),
        ),
      (err: unknown) => {
        assert.equal(err instanceof EmitPathCollisionError, true);
        const collision = err as EmitPathCollisionError;
        assert.equal(collision.targetPath, '.claude/skills/deploy/run.sh');
        assert.deepEqual(
          [...collision.sourcePaths].sort(),
          ['elsewhere/a/run.sh', 'elsewhere/b/run.sh'],
        );
        return true;
      },
    );
  });
});

describe('claudeAdapter — hooks → .claude/settings.json merge-key (EV5/UN1)', () => {
  it('emits the hooks key as merge-key with PascalCase events and $CLAUDE_PROJECT_DIR-anchored commands', () => {
    const projection = claudeAdapter.project(
      ir({ hooks: [hook('pre-tool-use', 'lint'), hook('pre-compact', 'save')] }),
      ctxWith(),
    );
    const file = fileAt(projection.files, '.claude/settings.json');
    assert.equal(file?.mode, 'merge-key');
    assert.equal(file?.mergeKey, 'hooks');
    const groups = hooksGroups(file?.body ?? '');
    assert.deepEqual(Object.keys(groups).sort(), ['PreCompact', 'PreToolUse']);
    assert.deepEqual(groups['PreToolUse'], [
      {
        hooks: [
          { type: 'command', command: '$CLAUDE_PROJECT_DIR/.agents/hooks/pre-tool-use.lint.sh' },
        ],
      },
    ]);
    assert.equal(projection.surfaces.hooks, 'merged');
  });

  it('targets only the hooks key, never overwriting the co-owned settings file (merge preserves user keys)', () => {
    const projection = claudeAdapter.project(
      ir({ hooks: [hook('stop', 'notify')] }),
      ctxWith({ '.claude/settings.json': '{"theme": "dark", "model": "opus"}' }),
    );
    const settingsEmits = projection.files.filter((file) => file.path === '.claude/settings.json');
    assert.equal(settingsEmits.length, 1);
    assert.equal(settingsEmits[0]?.mode, 'merge-key');
    assert.equal(settingsEmits[0]?.mergeKey, 'hooks');
  });

  it('maps every canonical event — Claude has all nine, so no HH-W003 fires', () => {
    const projection = claudeAdapter.project(
      ir({ hooks: [hook('session-end', 'teardown'), hook('subagent-start', 'track')] }),
      ctxWith(),
    );
    assert.deepEqual(projection.warnings, []);
    const groups = hooksGroups(fileAt(projection.files, '.claude/settings.json')?.body ?? '');
    assert.deepEqual(Object.keys(groups).sort(), ['SessionEnd', 'SubagentStart']);
  });

  it('throws MalformedProviderConfigError when settings.json is malformed and hooks must merge (UN1)', () => {
    assert.throws(
      () =>
        claudeAdapter.project(
          ir({ hooks: [hook('stop', 'notify')] }),
          ctxWith({ '.claude/settings.json': '{not json' }),
        ),
      (err: unknown) => {
        assert.equal(err instanceof MalformedProviderConfigError, true);
        const domainErr = err as MalformedProviderConfigError;
        assert.equal(domainErr.exitCode, 3);
        assert.match(domainErr.message, /\.claude\/settings\.json/);
        return true;
      },
    );
  });

  it('does not consult settings.json when the IR has no hooks (malformed file tolerated)', () => {
    const projection = claudeAdapter.project(
      ir({ instructions: [rootInstruction()] }),
      ctxWith({ '.claude/settings.json': '{not json' }),
    );
    assert.equal(projection.surfaces.hooks, 'skipped');
  });
});

describe('claudeAdapter.detectExisting', () => {
  it('names CLAUDE.md files, settings.json, and the rules/skills directories', () => {
    const snapshot: RepoSnapshot = {
      root: '/repo',
      files: [
        { path: 'CLAUDE.md', content: '@AGENTS.md\n' },
        { path: 'pkg/CLAUDE.md', content: '@AGENTS.md\n' },
        { path: '.claude/settings.json', content: '{}' },
        { path: '.claude/rules/hh.testing.md', content: 'x' },
        { path: '.claude/skills/deploy/SKILL.md', content: 'x' },
      ],
    };
    assert.deepEqual(claudeAdapter.detectExisting(snapshot), {
      providerId: 'claude',
      paths: ['CLAUDE.md', 'pkg/CLAUDE.md', '.claude/settings.json', '.claude/rules/', '.claude/skills/'],
    });
  });

  it('returns null when no claude-owned files exist', () => {
    assert.equal(claudeAdapter.detectExisting({ root: '/repo', files: [] }), null);
  });
});

describe('claudeAdapter — fixture round-trip (rules and skills)', () => {
  it('projects parsed canonical fragments and skills with bodies intact', async () => {
    // The F1 parser consumes the newline right after the closing `---`, so
    // the parsed body starts at the first content line.
    const fragmentBody = '# Testing conventions\n\nUse node:test.\n';
    const skillBody = '# Deploy\n\nRun the script.\n';
    const repo = await mkTempRepo({
      '.agents/instructions/testing.md': `---\nscope: "test/**/*.ts"\n---\n${fragmentBody}`,
      '.agents/skills/deploy/SKILL.md': `---\nname: deploy\ndescription: "Ship it"\n---\n${skillBody}`,
      '.agents/skills/deploy/scripts/run.sh': '#!/usr/bin/env bash\necho ship\n',
    });
    try {
      const { ir: parsed } = await parseRepo({ readRepo: () => readRepoSnapshot(repo.root) });
      const projection = claudeAdapter.project(parsed, { cwd: repo.root });

      const rule = fileAt(projection.files, '.claude/rules/hh.testing.md');
      const ruleLines = (rule?.body ?? '').split('\n');
      assert.equal(ruleLines[1], 'paths: ["test/**/*.ts"]');
      assert.equal(ruleLines.slice(4).join('\n'), fragmentBody);

      const skillMd = fileAt(projection.files, '.claude/skills/deploy/SKILL.md');
      const skillLines = (skillMd?.body ?? '').split('\n');
      assert.equal(skillLines[1], 'name: deploy');
      assert.equal(skillLines[2], 'description: "Ship it"');
      assert.equal(skillLines.slice(5).join('\n'), skillBody);

      const attachment = fileAt(projection.files, '.claude/skills/deploy/scripts/run.sh');
      assert.equal(attachment?.body, '#!/usr/bin/env bash\necho ship\n');
    } finally {
      await repo.cleanup();
    }
  });

  it('carries provider-specific skill frontmatter keys through parse→project (#38)', async () => {
    // The dogfood repro: a canonical skill with allowed-tools/argument-hint/trigger
    // must reach .claude/skills/<name>/SKILL.md intact — dropping allowed-tools
    // would silently loosen the skill's tool restrictions.
    const skillBody = '# Graphify\n\nDo the graph.\n';
    const repo = await mkTempRepo({
      'AGENTS.md': '# T\n\nHi.\n',
      '.agents/skills/graphify/SKILL.md':
        `---\nname: graphify\ndescription: "to a knowledge graph"\nallowed-tools: "read_file, edit_file"\nargument-hint: "<input>"\ntrigger: /graphify\n---\n${skillBody}`,
    });
    try {
      const { ir: parsed } = await parseRepo({ readRepo: () => readRepoSnapshot(repo.root) });
      const projection = claudeAdapter.project(parsed, { cwd: repo.root });
      const skillMd = fileAt(projection.files, '.claude/skills/graphify/SKILL.md');
      const fence = (skillMd?.body ?? '').indexOf('\n---\n');
      const frontmatter = (skillMd?.body ?? '').slice(0, fence);
      assert.match(frontmatter, /^allowed-tools: "read_file, edit_file"$/m);
      assert.match(frontmatter, /^argument-hint: "<input>"$/m);
      assert.match(frontmatter, /^trigger: \/graphify$/m);
    } finally {
      await repo.cleanup();
    }
  });
});
