/**
 * `audit` use case — INTEGRATION tests against a real filesystem in
 * os.tmpdir() (testing.md category 2). Each test builds a tiny canonical
 * repo, runs the apply-equivalent emission (`emitProjection`) so disk
 * matches the projection, then asserts the audit verdict. Every C1 EARS
 * rule maps to at least one `it` here.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import {
  audit,
  parseRepo,
  readRepoSnapshot,
  createAllAdapters,
  createProviderFileReader,
  createSymlinkAliasProbe,
} from '../../dist/index.js';
import type { ProviderId } from '../../dist/index.js';
import { mkTempRepo } from '../_helpers/tmp-repo.ts';
import type { TempRepo } from '../_helpers/tmp-repo.ts';
import { emitProjection, contextFactory } from '../_helpers/emit.ts';

const repos: TempRepo[] = [];
after(async () => {
  await Promise.all(repos.map((repo) => repo.cleanup()));
});

/**
 * A canonical repo that projects with ZERO warnings: a root AGENTS.md, a
 * skill, and a `pre-tool-use` hook (which maps cleanly for all four
 * providers). No scoped fragment — fragments are lossy for Gemini (HH-W007)
 * and would push a clean repo to exit 2. Emits clean by default.
 */
const CANONICAL: Record<string, string> = {
  'AGENTS.md': '# Project standards\n\nUse npm test.\n',
  '.agents/skills/foo/SKILL.md':
    '---\nname: foo\ndescription: Use when fooing\n---\n# Foo\n\nDo the thing.\n',
  '.agents/hooks/pre-tool-use.lint.sh': '#!/usr/bin/env bash\necho lint\n',
};

async function setup(
  files: Record<string, string>,
  options: { emit?: boolean; geminiMode?: 'settings' | 'shim' } = {},
): Promise<TempRepo> {
  const repo = await mkTempRepo(files);
  repos.push(repo);
  if (options.emit !== false) {
    await emitProjection(repo.root, { geminiMode: options.geminiMode });
  }
  return repo;
}

function runAudit(
  root: string,
  options: {
    strict?: boolean;
    disabled?: ProviderId[];
    geminiMode?: 'settings' | 'shim';
    failOn?: 'warn' | 'drift';
  } = {},
) {
  const reader = createProviderFileReader(root);
  const adapters = createAllAdapters().filter(
    (adapter) => !(options.disabled ?? []).includes(adapter.id),
  );
  return audit({
    parse: () => parseRepo({ readRepo: () => readRepoSnapshot(root) }),
    adapters,
    reader,
    contextFor: contextFactory(root, reader, options.geminiMode ?? 'settings'),
    aliasOf: createSymlinkAliasProbe(root),
    strict: options.strict,
    failOn: options.failOn,
  });
}

async function writeRel(root: string, rel: string, content: string): Promise<void> {
  const abs = join(root, ...rel.split('/'));
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

describe('audit() — clean repo (EV3, EV1)', () => {
  it('exits 0 with no drift when disk matches every projection', async () => {
    const repo = await setup(CANONICAL);
    const report = await runAudit(repo.root);
    assert.equal(report.exitCode, 0);
    assert.equal(report.drift, false);
    assert.ok(report.files.length > 0);
    assert.ok(report.files.every((f) => f.status === 'clean'));
  });

  it('makes zero filesystem writes (U1)', async () => {
    const repo = await setup(CANONICAL);
    const before = await snapshotDir(repo.root);
    await runAudit(repo.root);
    const afterState = await snapshotDir(repo.root);
    assert.deepEqual(afterState, before);
  });
});

describe('audit() — overwrite-file drift (EV1, §9 verify-by-class)', () => {
  it('reports drift:edited when a header-bearing overwrite file is hand-edited', async () => {
    const repo = await setup(CANONICAL);
    const ciPath = join(repo.root, '.github', 'copilot-instructions.md');
    await writeFile(ciPath, `${await readFile(ciPath, 'utf8')}\nHAND EDIT\n`, 'utf8');
    const report = await runAudit(repo.root);
    assert.equal(report.exitCode, 1);
    assert.equal(report.drift, true);
    const entry = report.files.find((f) => f.path.endsWith('copilot-instructions.md'));
    assert.equal(entry?.status, 'drift:edited');
  });

  it('reports drift:edited when a frontmatter-bearing file is hand-edited', async () => {
    const repo = await setup(CANONICAL);
    // .claude/skills/foo/SKILL.md carries YAML frontmatter; the header sits
    // after it and BODY_HASH covers frontmatter + body.
    const skillPath = join(repo.root, '.claude', 'skills', 'foo', 'SKILL.md');
    await writeFile(skillPath, `${await readFile(skillPath, 'utf8')}\nEDIT\n`, 'utf8');
    const report = await runAudit(repo.root);
    assert.equal(report.exitCode, 1);
    const entry = report.files.find((f) => f.path === '.claude/skills/foo/SKILL.md');
    assert.equal(entry?.status, 'drift:edited');
  });

  it('reports drift:missing when an emitted file is deleted', async () => {
    const repo = await setup(CANONICAL);
    await rm(join(repo.root, '.github', 'copilot-instructions.md'));
    const report = await runAudit(repo.root);
    assert.equal(report.exitCode, 1);
    const entry = report.files.find((f) => f.path.endsWith('copilot-instructions.md'));
    assert.equal(entry?.status, 'drift:missing');
  });

  it('reports drift:unmanaged when an owned path holds a foreign file', async () => {
    const repo = await setup(CANONICAL);
    await writeRel(repo.root, '.github/copilot-instructions.md', '# hand-written, no header\n');
    const report = await runAudit(repo.root);
    assert.equal(report.exitCode, 1);
    const entry = report.files.find((f) => f.path.endsWith('copilot-instructions.md'));
    assert.equal(entry?.status, 'drift:unmanaged');
  });

  it('reports drift:differs for a headerless JSON file that changed', async () => {
    const repo = await setup(CANONICAL);
    await writeRel(repo.root, '.codex/hooks.json', '{"hooks":{}}\n');
    const report = await runAudit(repo.root);
    assert.equal(report.exitCode, 1);
    const entry = report.files.find((f) => f.path === '.codex/hooks.json');
    assert.equal(entry?.status, 'drift:differs');
  });
});

describe('audit() — stale canonical sources (§9)', () => {
  it('reports drift when a canonical source changes but disk is not re-emitted', async () => {
    const repo = await setup(CANONICAL);
    // Change the canonical body: re-projection differs from on-disk emit.
    await writeRel(repo.root, 'AGENTS.md', '# Project standards\n\nUse pnpm test.\n');
    const report = await runAudit(repo.root);
    assert.equal(report.exitCode, 1);
    assert.equal(report.drift, true);
    const entry = report.files.find((f) => f.path.endsWith('copilot-instructions.md'));
    assert.equal(entry?.status, 'drift:stale');
  });
});

describe('audit() — merge-key drift (§9 carve-out 2, §10)', () => {
  it('clean when the owned key deep-equals the projection', async () => {
    const repo = await setup(CANONICAL);
    const report = await runAudit(repo.root);
    const claudeSettings = report.files.find(
      (f) => f.path === '.claude/settings.json' && f.mergeKey === 'hooks',
    );
    assert.equal(claudeSettings?.status, 'clean');
  });

  it('preserves foreign keys: a user theme key does not cause drift', async () => {
    const repo = await setup(CANONICAL);
    // Read the emitted .claude/settings.json, add a foreign key, re-write.
    const path = join(repo.root, '.claude', 'settings.json');
    const settings = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    settings['theme'] = 'dark';
    await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    const report = await runAudit(repo.root);
    const entry = report.files.find(
      (f) => f.path === '.claude/settings.json' && f.mergeKey === 'hooks',
    );
    assert.equal(entry?.status, 'clean');
    assert.equal(report.exitCode, 0);
  });

  it('reports drift:differs when the owned key value diverges', async () => {
    const repo = await setup(CANONICAL);
    const path = join(repo.root, '.claude', 'settings.json');
    const settings = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    settings['hooks'] = { Tampered: [] };
    await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    const report = await runAudit(repo.root);
    const entry = report.files.find(
      (f) => f.path === '.claude/settings.json' && f.mergeKey === 'hooks',
    );
    assert.equal(entry?.status, 'drift:differs');
    assert.equal(report.exitCode, 1);
  });

  it('reports drift:differs when the owned key is absent but the file EXISTS (gauntlet)', async () => {
    const repo = await setup(CANONICAL);
    const path = join(repo.root, '.claude', 'settings.json');
    // The file is present (user keeps a `theme` key) but lacks the owned `hooks`
    // key. That is divergence, not a missing FILE — `drift:differs`, so the
    // absent-provider hint never claims Claude "has no files".
    await writeFile(path, `${JSON.stringify({ theme: 'dark' }, null, 2)}\n`, 'utf8');
    const report = await runAudit(repo.root);
    const entry = report.files.find(
      (f) => f.path === '.claude/settings.json' && f.mergeKey === 'hooks',
    );
    assert.equal(entry?.status, 'drift:differs');
  });
});

describe('audit() — import shims (§9 carve-out 1, first-line ownership)', () => {
  it('stays clean when user content sits below the CLAUDE.md import line', async () => {
    const repo = await setup(CANONICAL);
    await writeRel(repo.root, 'CLAUDE.md', '@AGENTS.md\n\n# my private notes\n');
    const report = await runAudit(repo.root);
    assert.equal(report.exitCode, 0);
    assert.equal(report.drift, false);
  });

  it('audits clean in gemini shim mode when GEMINI.md carries the import', async () => {
    const repo = await setup(CANONICAL, { geminiMode: 'shim' });
    const report = await runAudit(repo.root, { geminiMode: 'shim' });
    assert.equal(report.exitCode, 0);
    assert.equal(report.drift, false);
  });

  it('reports drift:missing when GEMINI.md is deleted in shim mode', async () => {
    const repo = await setup(CANONICAL, { geminiMode: 'shim' });
    await rm(join(repo.root, 'GEMINI.md'));
    const report = await runAudit(repo.root, { geminiMode: 'shim' });
    assert.equal(report.exitCode, 1);
    const entry = report.files.find((f) => f.path === 'GEMINI.md');
    assert.equal(entry?.status, 'drift:missing');
  });

  it('warns HH-W005 (exit 2, no drift) when a shim target lacks the import line', async () => {
    const repo = await setup(CANONICAL, { geminiMode: 'shim' });
    await writeRel(repo.root, 'GEMINI.md', '# hand-written Gemini instructions\n');
    const report = await runAudit(repo.root, { geminiMode: 'shim' });
    assert.equal(report.drift, false);
    assert.equal(report.exitCode, 2);
    assert.ok(report.warnings.some((w) => w.code === 'HH-W005' && w.providerId === 'gemini'));
  });
});

describe('audit() — merge-key dot-path (context.fileName, §9 carve-out 2)', () => {
  it('reports drift:differs when AGENTS.md is missing from context.fileName', async () => {
    const repo = await setup(CANONICAL);
    const path = join(repo.root, '.gemini', 'settings.json');
    const settings = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    settings['context'] = { fileName: ['GEMINI.md'] };
    await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    const report = await runAudit(repo.root);
    assert.equal(report.exitCode, 1);
    const entry = report.files.find(
      (f) => f.path === '.gemini/settings.json' && f.mergeKey === 'context.fileName',
    );
    assert.equal(entry?.status, 'drift:differs');
  });

  it('reports drift:differs when the nested context key is absent but the file EXISTS (gauntlet)', async () => {
    const repo = await setup(CANONICAL);
    const path = join(repo.root, '.gemini', 'settings.json');
    const settings = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    delete settings['context'];
    await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');
    const report = await runAudit(repo.root);
    assert.equal(report.exitCode, 1);
    const entry = report.files.find(
      (f) => f.path === '.gemini/settings.json' && f.mergeKey === 'context.fileName',
    );
    // File present, owned key absent → divergence, not a missing file.
    assert.equal(entry?.status, 'drift:differs');
  });

  it('the absent-provider hint does NOT fire for a present-but-keyless .gemini/settings.json (gauntlet)', async () => {
    // The Codex+Thermos false-positive: a hand-kept .gemini/settings.json with
    // no context.fileName must NOT be reported as "gemini has no files".
    const repo = await setup(CANONICAL);
    const path = join(repo.root, '.gemini', 'settings.json');
    await writeFile(path, `${JSON.stringify({ theme: 'x' }, null, 2)}\n`, 'utf8');
    const report = await runAudit(repo.root);
    const gemini = report.files.find(
      (f) => f.path === '.gemini/settings.json' && f.mergeKey === 'context.fileName',
    );
    assert.equal(gemini?.status, 'drift:differs', 'present-but-keyless settings.json is drift:differs, not missing');
  });
});

describe('audit() — lossy warnings (EV4, OPT1)', () => {
  // A scoped fragment is unrepresentable for Gemini → HH-W007 (lossy), while
  // the rest of the repo emits clean.
  const LOSSY: Record<string, string> = {
    'AGENTS.md': '# Project\n\nUse npm test.\n',
    '.agents/instructions/testing.md':
      '---\nscope: "test/**/*.ts"\n---\n# Testing\n\nUse node:test.\n',
  };

  it('exits 2 when only lossy warnings fire and disk is clean (EV4)', async () => {
    const repo = await setup(LOSSY);
    const report = await runAudit(repo.root);
    assert.equal(report.drift, false);
    assert.equal(report.exitCode, 2);
    assert.ok(report.warnings.some((w) => w.code === 'HH-W007' && w.providerId === 'gemini'));
  });

  it('drift takes precedence over warnings: exit 1 not 2 (EV4)', async () => {
    const repo = await setup(LOSSY);
    await rm(join(repo.root, '.github', 'copilot-instructions.md'));
    const report = await runAudit(repo.root);
    assert.equal(report.drift, true);
    assert.equal(report.exitCode, 1);
    assert.ok(report.warnings.some((w) => w.code === 'HH-W007'));
  });

  it('--strict escalates a lossy-only warning to exit 1 (OPT1)', async () => {
    const repo = await setup(LOSSY);
    const report = await runAudit(repo.root, { strict: true });
    assert.equal(report.drift, false);
    assert.equal(report.exitCode, 1);
  });

  it('--fail-on drift makes a lossy-only warning exit 0, not 2 (#43)', async () => {
    const repo = await setup(LOSSY);
    const report = await runAudit(repo.root, { failOn: 'drift' });
    assert.equal(report.drift, false);
    // The warning is still reported; only the exit code is de-escalated.
    assert.ok(report.warnings.some((w) => w.code === 'HH-W007'));
    assert.equal(report.exitCode, 0);
  });

  it('--fail-on drift still fails (exit 1) on real drift (#43)', async () => {
    const repo = await setup(LOSSY);
    await rm(join(repo.root, '.github', 'copilot-instructions.md'));
    const report = await runAudit(repo.root, { failOn: 'drift' });
    assert.equal(report.drift, true);
    assert.equal(report.exitCode, 1);
  });

  it('--fail-on drift overrides --strict for warnings (de-escalates to 0) (#43)', async () => {
    const repo = await setup(LOSSY);
    const report = await runAudit(repo.root, { strict: true, failOn: 'drift' });
    assert.equal(report.drift, false);
    assert.equal(report.exitCode, 0);
  });

  // The §9 v0.3.1 amendment exists so an edit to an emitted frontmatter glob
  // line (applyTo:/paths:) is detected. The entity-level test pins this on
  // verifyHeaderAfterFrontmatter; this pins the headline scenario end-to-end
  // through audit() on a real Copilot .instructions.md.
  it('reports drift:edited when an emitted applyTo: glob line is hand-edited (§9 v0.3.1)', async () => {
    const repo = await setup(LOSSY);
    const path = join(repo.root, '.github', 'instructions', 'hh.testing.instructions.md');
    const original = await readFile(path, 'utf8');
    assert.match(original, /applyTo:/);
    await writeFile(path, original.replace('test/**/*.ts', 'src/**/*.ts'), 'utf8');
    const report = await runAudit(repo.root, { disabled: ['gemini'] });
    assert.equal(report.drift, true);
    assert.equal(report.exitCode, 1);
    const entry = report.files.find(
      (f) => f.path === '.github/instructions/hh.testing.instructions.md',
    );
    assert.equal(entry?.status, 'drift:edited');
  });
});

describe('audit() — invalid canonical sources (UN1)', () => {
  it('propagates a ParseError (exit 3) for malformed canonical input', async () => {
    // A scoped fragment missing its required scope: frontmatter → ParseError.
    const repo = await setup(
      {
        'AGENTS.md': '# Project\n',
        '.agents/instructions/broken.md': '# no frontmatter, no scope\n',
      },
      { emit: false },
    );
    await assert.rejects(
      () => runAudit(repo.root),
      (err: unknown) => err instanceof Error && (err as { exitCode?: number }).exitCode === 3,
    );
  });

  // A co-owned provider file that is syntactically malformed surfaces during
  // projection (claude reads .claude/settings.json to merge the hooks key) as
  // exit 3 — before the merge-key verifier runs. Pins the behavior the
  // auditMergeKeyFile comment describes.
  it('propagates exit 3 when a co-owned settings file is malformed JSON', async () => {
    const repo = await setup(CANONICAL);
    await writeRel(repo.root, '.claude/settings.json', '{ not valid json');
    await assert.rejects(
      () => runAudit(repo.root),
      (err: unknown) => err instanceof Error && (err as { exitCode?: number }).exitCode === 3,
    );
  });
});

describe('audit() — config-driven provider filtering', () => {
  it('skips audits for disabled providers', async () => {
    const repo = await setup(CANONICAL);
    const report = await runAudit(repo.root, { disabled: ['gemini', 'copilot'] });
    assert.ok(report.files.every((f) => f.providerId !== 'gemini' && f.providerId !== 'copilot'));
  });
});

describe('audit() — JSON report shape (EV2)', () => {
  it('produces a serializable AuditReport with the documented fields', async () => {
    const repo = await setup(CANONICAL);
    const report = await runAudit(repo.root);
    const round = JSON.parse(JSON.stringify(report)) as typeof report;
    assert.deepEqual(Object.keys(round).sort(), ['drift', 'exitCode', 'files', 'warnings']);
    assert.equal(typeof round.exitCode, 'number');
    assert.equal(typeof round.drift, 'boolean');
    assert.ok(Array.isArray(round.files));
    for (const file of round.files) {
      assert.equal(typeof file.path, 'string');
      assert.equal(typeof file.providerId, 'string');
      assert.equal(typeof file.status, 'string');
    }
  });
});

describe('audit() — performance (§16)', () => {
  it(
    'exits 0 on a clean repo in under 100ms',
    { skip: 'timing-sensitive; un-skip to measure locally' },
    async () => {
      const repo = await setup(CANONICAL);
      const start = performance.now();
      const report = await runAudit(repo.root);
      const elapsed = performance.now() - start;
      assert.equal(report.exitCode, 0);
      assert.ok(elapsed < 100, `audit took ${elapsed.toFixed(1)}ms`);
    },
  );
});

/** Recursively snapshots a directory's file paths + contents for the U1 check. */
async function snapshotDir(root: string): Promise<Record<string, string>> {
  const { readdir } = await import('node:fs/promises');
  const out: Record<string, string> = {};
  async function walk(rel: string): Promise<void> {
    const abs = rel === '' ? root : join(root, ...rel.split('/'));
    const entries = await readdir(abs, { withFileTypes: true });
    for (const entry of entries) {
      const childRel = rel === '' ? entry.name : `${rel}/${entry.name}`;
      if (entry.isDirectory()) {
        await walk(childRel);
      } else if (entry.isFile()) {
        out[childRel] = await readFile(join(root, ...childRel.split('/')), 'utf8');
      }
    }
  }
  await walk('');
  return out;
}

describe('audit() — #35 symlink-aliased targets', () => {
  it('reports the aliased path as `aliased` (not drift) with HH-W013, exit 2', async () => {
    const { symlink } = await import('node:fs/promises');
    // Emit real projections first, then swap the claude skill dir for the
    // cerebro-style hand-made symlink into the canonical tree.
    const repo = await setup(CANONICAL);
    await rm(join(repo.root, '.claude', 'skills', 'foo'), { recursive: true, force: true });
    await symlink(
      join('..', '..', '.agents', 'skills', 'foo'),
      join(repo.root, '.claude', 'skills', 'foo'),
    );

    const report = await runAudit(repo.root);
    const entry = report.files.find((file) => file.path === '.claude/skills/foo/SKILL.md');
    assert.equal(entry?.status, 'aliased');
    // `aliased` is not drift — the pre-#35 behavior reported drift:stale here
    // after apply clobbered the canonical source through the symlink.
    assert.equal(report.drift, false);
    assert.equal(report.exitCode, 2);
    const warning = report.warnings.find((w) => w.code === 'HH-W013');
    assert.match(warning?.message ?? '', /\.agents\/skills\/foo\/SKILL\.md/);
  });

  it('escalates the HH-W013 warning to exit 1 under --strict', async () => {
    const { symlink } = await import('node:fs/promises');
    const repo = await setup(CANONICAL);
    await rm(join(repo.root, '.claude', 'skills', 'foo'), { recursive: true, force: true });
    await symlink(
      join('..', '..', '.agents', 'skills', 'foo'),
      join(repo.root, '.claude', 'skills', 'foo'),
    );
    const report = await runAudit(repo.root, { strict: true });
    assert.equal(report.exitCode, 1);
  });
});
