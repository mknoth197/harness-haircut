/**
 * `apply` use case — INTEGRATION tests against a real filesystem in
 * os.tmpdir() (testing.md category 2). Each test builds a tiny canonical
 * repo, runs `apply` with injected gateways (a real filesystem reader +
 * writer, a mock `isDirty`, a scripted `confirm`, and the state-file
 * read/write the CLI uses), then asserts the write decisions and the
 * resulting disk. Every C2 EARS rule maps to at least one `it` here, plus the
 * required idempotency check (apply → audit exits 0).
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile, rm, mkdir, readdir, symlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import {
  apply,
  audit,
  parseRepo,
  readRepoSnapshot,
  createAllAdapters,
  createProviderFileReader,
  createFileWriter,
  parseState,
  serializeState,
  APPLY_STATE_PATH,
  createSymlinkAliasProbe,
} from '../../dist/index.js';
import type { ApplyReport, ApplyState, ProviderId } from '../../dist/index.js';
import { mkTempRepo } from '../_helpers/tmp-repo.ts';
import type { TempRepo } from '../_helpers/tmp-repo.ts';
import { contextFactory } from '../_helpers/emit.ts';

const repos: TempRepo[] = [];
after(async () => {
  await Promise.all(repos.map((repo) => repo.cleanup()));
});

/** A canonical repo that projects with zero warnings (mirrors audit.test.ts). */
const CANONICAL: Record<string, string> = {
  'AGENTS.md': '# Project standards\n\nUse npm test.\n',
  '.agents/skills/foo/SKILL.md':
    '---\nname: foo\ndescription: Use when fooing\n---\n# Foo\n\nDo the thing.\n',
  '.agents/hooks/pre-tool-use.lint.sh': '#!/usr/bin/env bash\necho lint\n',
};

interface RunApplyOptions {
  dirty?: boolean;
  allowDirty?: boolean;
  dryRun?: boolean;
  nonInteractive?: boolean;
  /** Scripted answers to the `edited` prompt, keyed by emitted path. */
  confirm?: Record<string, boolean> | ((path: string) => boolean);
  geminiMode?: 'settings' | 'shim';
  disabled?: ProviderId[];
}

async function setup(files: Record<string, string>): Promise<TempRepo> {
  const repo = await mkTempRepo(files);
  repos.push(repo);
  return repo;
}

function runApply(root: string, options: RunApplyOptions = {}): Promise<ApplyReport> {
  const reader = createProviderFileReader(root);
  const writer = createFileWriter(root);
  const adapters = createAllAdapters().filter(
    (adapter) => !(options.disabled ?? []).includes(adapter.id),
  );
  const confirmFn = (path: string): Promise<boolean> => {
    if (typeof options.confirm === 'function') {
      return Promise.resolve(options.confirm(path));
    }
    return Promise.resolve(options.confirm?.[path] ?? false);
  };
  return apply({
    parse: () => parseRepo({ readRepo: () => readRepoSnapshot(root) }),
    adapters,
    reader,
    writer,
    contextFor: contextFactory(root, reader, options.geminiMode ?? 'settings'),
    isDirty: () => Promise.resolve(options.dirty ?? false),
    confirm: confirmFn,
    readState: (): ApplyState => parseState(reader.read(APPLY_STATE_PATH)),
    writeState: (state: ApplyState): void => writer.write(APPLY_STATE_PATH, serializeState(state)),
    aliasOf: createSymlinkAliasProbe(root),
    flags: {
      allowDirty: options.allowDirty ?? false,
      dryRun: options.dryRun ?? false,
      nonInteractive: options.nonInteractive ?? false,
    },
  });
}

function runAudit(root: string, options: { geminiMode?: 'settings' | 'shim' } = {}) {
  const reader = createProviderFileReader(root);
  return audit({
    parse: () => parseRepo({ readRepo: () => readRepoSnapshot(root) }),
    adapters: createAllAdapters(),
    reader,
    contextFor: contextFactory(root, reader, options.geminiMode ?? 'settings'),
    aliasOf: createSymlinkAliasProbe(root),
  });
}

async function writeRel(root: string, rel: string, content: string): Promise<void> {
  const abs = join(root, ...rel.split('/'));
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

/** Recursively snapshots a directory's file paths + contents. */
async function snapshotDir(root: string): Promise<Record<string, string>> {
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

describe('apply() — clean / nothing-to-do (EV1)', () => {
  it('first apply writes the projection; an immediate second apply does nothing (EV1, EV2)', async () => {
    const repo = await setup(CANONICAL);
    const first = await runApply(repo.root);
    assert.equal(first.exitCode, 0);
    assert.ok(first.written.length > 0);
    assert.equal(first.nothingToDo, false);

    const second = await runApply(repo.root);
    assert.equal(second.exitCode, 0);
    assert.equal(second.nothingToDo, true);
    assert.deepEqual(second.written, []);
  });
});

describe('apply() — overwrite drift (EV2)', () => {
  it('rewrites a drifted header-bearing overwrite file and reports it', async () => {
    const repo = await setup(CANONICAL);
    await runApply(repo.root);
    // Change canonical sources so the projection goes stale on disk.
    await writeRel(repo.root, 'AGENTS.md', '# Project standards\n\nUse pnpm test.\n');
    const report = await runApply(repo.root);
    assert.equal(report.exitCode, 0);
    const ci = report.files.find((f) => f.path.endsWith('copilot-instructions.md'));
    assert.equal(ci?.action, 'written');
    assert.equal(ci?.reason, 'stale');
    const onDisk = await readFile(join(repo.root, '.github', 'copilot-instructions.md'), 'utf8');
    assert.match(onDisk, /pnpm test/);
  });

  it('writes a missing overwrite file (reason: missing)', async () => {
    const repo = await setup(CANONICAL);
    await runApply(repo.root);
    await rm(join(repo.root, '.github', 'copilot-instructions.md'));
    const report = await runApply(repo.root);
    const ci = report.files.find((f) => f.path.endsWith('copilot-instructions.md'));
    assert.equal(ci?.action, 'written');
    assert.equal(ci?.reason, 'missing');
  });
});

describe('apply() — merge-key (EV3, §10 preserve foreign keys)', () => {
  it('replaces only the owned key and preserves a foreign theme key', async () => {
    const repo = await setup(CANONICAL);
    await runApply(repo.root);
    // Add a foreign key alongside the owned `hooks` key.
    const path = join(repo.root, '.claude', 'settings.json');
    const settings = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    settings['theme'] = 'dark';
    await writeFile(path, `${JSON.stringify(settings, null, 2)}\n`, 'utf8');

    // Change canonical hooks so the owned key must be rewritten.
    await writeRel(repo.root, '.agents/hooks/post-tool-use.fmt.sh', '#!/usr/bin/env bash\nfmt\n');
    const report = await runApply(repo.root);
    assert.equal(report.exitCode, 0);

    const after = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>;
    assert.equal(after['theme'], 'dark', 'foreign key must be preserved');
    assert.ok('hooks' in after, 'owned key must be present');
    const entry = report.files.find(
      (f) => f.path === '.claude/settings.json' && f.mergeKey === 'hooks',
    );
    assert.equal(entry?.action, 'written');
    assert.equal(entry?.reason, 'merge-changed');
  });

  it('skips a merge-key file whose owned key already matches', async () => {
    const repo = await setup(CANONICAL);
    await runApply(repo.root);
    const report = await runApply(repo.root);
    const entry = report.files.find(
      (f) => f.path === '.claude/settings.json' && f.mergeKey === 'hooks',
    );
    assert.equal(entry?.action, 'skipped');
  });

  // The highest-risk merge: a dot-path owned key (Gemini `context.fileName`)
  // must replace only its leaf and preserve a foreign SIBLING under the same
  // parent object (`context.otherKey`) as well as foreign top-level keys.
  it('preserves a foreign sibling under a dot-path owned key (context.otherKey)', async () => {
    const repo = await setup(CANONICAL);
    await runApply(repo.root);
    const path = join(repo.root, '.gemini', 'settings.json');
    await writeFile(
      path,
      `${JSON.stringify({ context: { fileName: 'STALE', otherKey: 'keep-me' }, theme: 'x' }, null, 2)}\n`,
      'utf8',
    );
    const report = await runApply(repo.root);
    assert.equal(report.exitCode, 0);
    const after = JSON.parse(await readFile(path, 'utf8')) as {
      context: { fileName: string[]; otherKey: unknown };
      theme: unknown;
    };
    // The adapter merges AGENTS.md into the existing value (A3 EV5 string→array
    // promotion, preserving the user's prior entry) — the owned leaf was rewritten.
    assert.ok(
      Array.isArray(after.context.fileName) && after.context.fileName.includes('AGENTS.md'),
      'owned leaf rewritten to include AGENTS.md',
    );
    // The point of this test: a foreign SIBLING under the dot-path parent survives.
    assert.equal(after.context.otherKey, 'keep-me', 'foreign sibling under context preserved');
    assert.equal(after.theme, 'x', 'foreign top-level key preserved');
  });
});

describe('apply() — UN2 malformed merge-key target', () => {
  it('fails with exit 3 when a co-owned settings target is malformed (projection path)', async () => {
    const repo = await setup(CANONICAL);
    await runApply(repo.root);
    // claude/gemini pre-read their co-owned settings.json during projection,
    // so a malformed file surfaces as MalformedProviderConfigError (exit 3)
    // there — the same exit code UN2 requires.
    await writeRel(repo.root, '.gemini/settings.json', '{ not valid json');
    await assert.rejects(
      () => runApply(repo.root),
      (err: unknown) => err instanceof Error && (err as { exitCode?: number }).exitCode === 3,
    );
  });

  it("fails with exit 3 naming the file in apply's own merge backstop", async () => {
    const repo = await setup(CANONICAL);
    // A hand-rolled merge-key adapter that does NOT pre-read its target, so
    // apply's own planMergeKey is what must reject the malformed JSON (the
    // backstop the audit comment describes). Target a fresh malformed file.
    await writeRel(repo.root, 'custom.json', '{ not valid json');
    const reader = createProviderFileReader(repo.root);
    const writer = createFileWriter(repo.root);
    const mergeAdapter = {
      id: 'codex' as ProviderId,
      project: () => ({
        files: [
          {
            path: 'custom.json',
            body: JSON.stringify({ a: 1 }),
            mode: 'merge-key' as const,
            mergeKey: 'owned',
          },
        ],
        warnings: [],
        surfaces: {
          instructions: 'native' as const,
          skills: 'native' as const,
          hooks: 'native' as const,
        },
      }),
      detectExisting: () => null,
    };
    await assert.rejects(
      () =>
        apply({
          parse: () => parseRepo({ readRepo: () => readRepoSnapshot(repo.root) }),
          adapters: [mergeAdapter],
          reader,
          writer,
          contextFor: contextFactory(repo.root, reader),
          isDirty: () => Promise.resolve(false),
          confirm: () => Promise.resolve(false),
          readState: () => parseState(reader.read(APPLY_STATE_PATH)),
          writeState: () => {},
          flags: { allowDirty: false, dryRun: false, nonInteractive: false },
        }),
      (err: unknown) =>
        err instanceof Error &&
        (err as { exitCode?: number }).exitCode === 3 &&
        /custom\.json/.test(err.message),
    );
  });
});

describe('apply() — prototype-pollution guard (FIX 3, security hardening)', () => {
  it('rejects a merge key containing __proto__ and does not pollute Object.prototype', async () => {
    const repo = await setup(CANONICAL);
    const reader = createProviderFileReader(repo.root);
    const writer = createFileWriter(repo.root);
    // A synthetic merge-key adapter whose mergeKey carries a __proto__ segment.
    const pollutingAdapter = {
      id: 'codex' as ProviderId,
      project: () => ({
        files: [
          {
            path: 'evil.json',
            body: JSON.stringify({ polluted: true }),
            mode: 'merge-key' as const,
            mergeKey: '__proto__.polluted',
          },
        ],
        warnings: [],
        surfaces: {
          instructions: 'native' as const,
          skills: 'native' as const,
          hooks: 'native' as const,
        },
      }),
      detectExisting: () => null,
    };
    await assert.rejects(
      () =>
        apply({
          parse: () => parseRepo({ readRepo: () => readRepoSnapshot(repo.root) }),
          adapters: [pollutingAdapter],
          reader,
          writer,
          contextFor: contextFactory(repo.root, reader),
          isDirty: () => Promise.resolve(false),
          confirm: () => Promise.resolve(false),
          readState: () => parseState(reader.read(APPLY_STATE_PATH)),
          writeState: () => {},
          flags: { allowDirty: false, dryRun: false, nonInteractive: false },
        }),
      (err: unknown) =>
        err instanceof Error &&
        (err as { exitCode?: number }).exitCode === 3 &&
        /__proto__/.test(err.message),
    );
    // Object.prototype was not polluted by the rejected merge.
    assert.equal(({} as Record<string, unknown>)['polluted'], undefined);
  });
});

describe('apply() — STATE1 dirty tree', () => {
  it('refuses with exit 1 on a dirty tree without --allow-dirty (writes nothing)', async () => {
    const repo = await setup(CANONICAL);
    const before = await snapshotDir(repo.root);
    const report = await runApply(repo.root, { dirty: true });
    assert.equal(report.exitCode, 1);
    assert.equal(report.refused, 'dirty-tree');
    assert.deepEqual(await snapshotDir(repo.root), before, 'no files written when refused');
  });

  it('runs on a dirty tree when --allow-dirty is passed', async () => {
    const repo = await setup(CANONICAL);
    const report = await runApply(repo.root, { dirty: true, allowDirty: true });
    assert.equal(report.exitCode, 0);
    assert.ok(report.written.length > 0);
  });
});

describe('apply() — OPT1 dry run', () => {
  it('computes the plan, writes nothing, exits 0', async () => {
    const repo = await setup(CANONICAL);
    const before = await snapshotDir(repo.root);
    const report = await runApply(repo.root, { dryRun: true });
    assert.equal(report.exitCode, 0);
    assert.equal(report.dryRun, true);
    assert.ok(report.written.length > 0, 'dry run reports what it would write');
    assert.deepEqual(await snapshotDir(repo.root), before, 'dry run mutates nothing');
    // The state file must NOT be written on a dry run.
    assert.equal(existsSync(join(repo.root, '.agents', '.harness-state.json')), false);
  });
});

describe('apply() — UN1 edited header file prompt path', () => {
  it('overwrites an edited header file when confirm says yes', async () => {
    const repo = await setup(CANONICAL);
    await runApply(repo.root);
    const ciPath = join(repo.root, '.github', 'copilot-instructions.md');
    const original = await readFile(ciPath, 'utf8');
    await writeFile(ciPath, `${original}\nHAND EDIT\n`, 'utf8');
    const report = await runApply(repo.root, {
      confirm: { '.github/copilot-instructions.md': true },
    });
    assert.equal(report.exitCode, 0);
    const ci = report.files.find((f) => f.path.endsWith('copilot-instructions.md'));
    assert.equal(ci?.action, 'written');
    assert.equal(ci?.reason, 'edited');
    const after = await readFile(ciPath, 'utf8');
    assert.doesNotMatch(after, /HAND EDIT/, 'edited content overwritten on confirm');
  });

  it('leaves an edited header file untouched and reports exit 1 under --non-interactive', async () => {
    const repo = await setup(CANONICAL);
    await runApply(repo.root);
    const ciPath = join(repo.root, '.github', 'copilot-instructions.md');
    const edited = `${await readFile(ciPath, 'utf8')}\nHAND EDIT\n`;
    await writeFile(ciPath, edited, 'utf8');
    const report = await runApply(repo.root, { nonInteractive: true });
    assert.equal(report.exitCode, 1);
    assert.ok(report.blocked.includes('.github/copilot-instructions.md'));
    assert.equal(await readFile(ciPath, 'utf8'), edited, 'blocked file untouched');
  });

  it('a declined headerless edit stays edited on the next apply (state not recorded for blocked)', async () => {
    const repo = await setup(CANONICAL);
    await runApply(repo.root);
    // Make .codex/hooks.json differ with no matching recorded hash by hand-
    // editing it AFTER the first apply, then deleting the state entry path is
    // not needed: a hand edit differs from both projection and recorded hash
    // → edited. Decline twice; it must remain edited (state never recorded it).
    await writeRel(repo.root, '.codex/hooks.json', '{"hooks":{},"userTweak":true}\n');
    const first = await runApply(repo.root, { confirm: () => false });
    assert.ok(first.blocked.includes('.codex/hooks.json'));
    const second = await runApply(repo.root, { confirm: () => false });
    assert.ok(
      second.blocked.includes('.codex/hooks.json'),
      'a previously-blocked edit must still be classified edited, not silently overwritable',
    );
  });
});

describe('apply() — UN3 two overwrite emits target the same path', () => {
  it('fails before any write when two adapters fully own the same path', async () => {
    const repo = await setup(CANONICAL);
    await runApply(repo.root);
    // Inject a duplicate overwrite emit at copilot's instructions path by
    // building deps with a hand-rolled adapter that collides with copilot.
    const reader = createProviderFileReader(repo.root);
    const writer = createFileWriter(repo.root);
    let wrote = false;
    const trackingWriter = {
      read: writer.read,
      exists: writer.exists,
      write: (p: string, c: string): void => {
        wrote = true;
        writer.write(p, c);
      },
    };
    const collidingAdapter = {
      id: 'codex' as ProviderId,
      project: () => ({
        files: [
          {
            path: '.github/copilot-instructions.md',
            body: '<!-- @generated SignedSource<<<aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb>>> x -->\nx\n',
            mode: 'overwrite' as const,
          },
        ],
        warnings: [],
        surfaces: { instructions: 'emitted' as const, skills: 'native' as const, hooks: 'native' as const },
      }),
      detectExisting: () => null,
    };
    const copilot = createAllAdapters().find((a) => a.id === 'copilot')!;
    await assert.rejects(
      () =>
        apply({
          parse: () => parseRepo({ readRepo: () => readRepoSnapshot(repo.root) }),
          adapters: [copilot, collidingAdapter],
          reader,
          writer: trackingWriter,
          contextFor: contextFactory(repo.root, reader),
          isDirty: () => Promise.resolve(false),
          confirm: () => Promise.resolve(false),
          readState: () => parseState(reader.read(APPLY_STATE_PATH)),
          writeState: () => {},
          flags: { allowDirty: false, dryRun: false, nonInteractive: false },
        }),
      (err: unknown) => err instanceof Error && /same file/.test(err.message),
    );
    assert.equal(wrote, false, 'no write happened before the collision was detected');
  });
});

describe('apply() — headerless .codex/hooks.json state-file three-way (design note)', () => {
  it('overwrites a stale headerless file without prompting (state says stale)', async () => {
    const repo = await setup(CANONICAL);
    await runApply(repo.root); // records state hash for .codex/hooks.json
    // Change canonical hooks → the projection changes. Disk still equals the
    // PRIOR emission (recorded hash), so it must be classified stale, not
    // edited: overwrite freely, no prompt. Use a confirm that throws so a
    // prompt would fail the test.
    await writeRel(repo.root, '.agents/hooks/post-tool-use.fmt.sh', '#!/usr/bin/env bash\nfmt\n');
    const report = await runApply(repo.root, {
      confirm: () => {
        throw new Error('must not prompt for a stale headerless file');
      },
    });
    assert.equal(report.exitCode, 0);
    const entry = report.files.find((f) => f.path === '.codex/hooks.json');
    assert.equal(entry?.action, 'written');
    assert.equal(entry?.reason, 'stale');
  });

  it('treats a differing headerless file with no state entry as edited (prompts)', async () => {
    const repo = await setup(CANONICAL);
    await runApply(repo.root);
    // Delete the state file so there is no recorded prior emission, then make
    // the on-disk hooks.json differ from the projection. With no state and a
    // difference, the three-way is conservatively `edited` → prompt.
    await rm(join(repo.root, '.agents', '.harness-state.json'));
    await writeRel(repo.root, '.codex/hooks.json', '{"hooks":{"PreToolUse":[]},"extra":1}\n');
    let prompted = false;
    const report = await runApply(repo.root, {
      confirm: (path) => {
        if (path === '.codex/hooks.json') {
          prompted = true;
        }
        return false; // decline
      },
    });
    assert.equal(prompted, true, 'a no-state differing headerless file must prompt');
    const entry = report.files.find((f) => f.path === '.codex/hooks.json');
    assert.equal(entry?.action, 'blocked');
  });
});

describe('apply() — state file (design note)', () => {
  it('writes the state file after a successful apply and the parser ignores it', async () => {
    const repo = await setup(CANONICAL);
    await runApply(repo.root);
    const statePath = join(repo.root, '.agents', '.harness-state.json');
    assert.equal(existsSync(statePath), true);
    const state = JSON.parse(await readFile(statePath, 'utf8')) as ApplyState;
    assert.equal(state.version, 1);
    assert.ok('.codex/hooks.json' in state.emitted, 'records the codex headerless file hash');

    // The state file lives under .agents/ but must not become an IR
    // attachment (no HH-W010 for it) — audit stays clean and independent.
    const auditReport = await runAudit(repo.root);
    assert.ok(
      !auditReport.warnings.some((w) => w.canonicalPath === APPLY_STATE_PATH),
      'state file must not surface as a parse attachment/warning',
    );
    assert.ok(
      !auditReport.files.some((f) => f.path === APPLY_STATE_PATH),
      'state file is never an emitted/audited file',
    );
  });
});

describe('apply() — idempotency (acceptance criterion)', () => {
  it('apply then audit() exits 0', async () => {
    const repo = await setup(CANONICAL);
    const applied = await runApply(repo.root);
    assert.equal(applied.exitCode, 0);
    const auditReport = await runAudit(repo.root);
    assert.equal(auditReport.exitCode, 0);
    assert.equal(auditReport.drift, false);
  });
});

describe('apply() — U1 writes only adapter-declared paths', () => {
  it('does not delete or touch files outside the emitted set', async () => {
    const repo = await setup(CANONICAL);
    // A user file at an unmanaged path must survive apply untouched.
    await writeRel(repo.root, 'README.md', '# my project\n');
    await runApply(repo.root);
    assert.equal(await readFile(join(repo.root, 'README.md'), 'utf8'), '# my project\n');
  });
});

describe('apply() — #35 symlink-aliased targets', () => {
  /** The cerebro shape: the claude skill dir is a hand-made symlink into .agents/. */
  async function aliasedRepo(): Promise<TempRepo> {
    const repo = await setup({
      ...CANONICAL,
      // Seeds .claude/skills/ as a REAL directory next to the symlink.
      '.claude/skills/keep.md': 'unmanaged sibling\n',
    });
    await symlink(
      join('..', '..', '.agents', 'skills', 'foo'),
      join(repo.root, '.claude', 'skills', 'foo'),
    );
    return repo;
  }

  it('skips the aliased projection with HH-W013 and never touches the canonical source', async () => {
    const repo = await aliasedRepo();
    const canonicalBefore = await readFile(
      join(repo.root, '.agents', 'skills', 'foo', 'SKILL.md'),
      'utf8',
    );

    const report = await runApply(repo.root);
    assert.equal(report.exitCode, 0);

    const aliased = report.files.find((file) => file.path === '.claude/skills/foo/SKILL.md');
    assert.equal(aliased?.action, 'skipped');
    assert.equal(aliased?.reason, 'aliased');
    assert.equal(report.written.includes('.claude/skills/foo/SKILL.md'), false);
    const warning = report.warnings.find((w) => w.code === 'HH-W013');
    assert.notEqual(warning, undefined);
    assert.match(warning?.message ?? '', /\.agents\/skills\/foo\/SKILL\.md/);

    // The canonical source behind the symlink is byte-identical (#35's
    // original failure overwrote it through the symlinked parent).
    assert.equal(
      await readFile(join(repo.root, '.agents', 'skills', 'foo', 'SKILL.md'), 'utf8'),
      canonicalBefore,
    );
  });

  it('keeps apply→audit idempotent: aliased is not drift, exit 2 (warning only)', async () => {
    const repo = await aliasedRepo();
    const applied = await runApply(repo.root);
    assert.equal(applied.exitCode, 0);

    const auditReport = await runAudit(repo.root);
    assert.equal(auditReport.drift, false);
    const entry = auditReport.files.find((file) => file.path === '.claude/skills/foo/SKILL.md');
    assert.equal(entry?.status, 'aliased');
    assert.equal(auditReport.exitCode, 2);
  });

  it('excludes the aliased path from the recorded apply state', async () => {
    const repo = await aliasedRepo();
    await runApply(repo.root);
    const reader = createProviderFileReader(repo.root);
    const state = parseState(reader.read(APPLY_STATE_PATH));
    assert.equal('.claude/skills/foo/SKILL.md' in state.emitted, false);
  });

  // Review M1: `.agents` ITSELF as an in-repo symlink (stow/chezmoi shape).
  // The state file lives under `.agents/`, so an unguarded writeState crashed
  // exit 70 mid-run AFTER the provider files landed.
  it('completes when .agents itself is a symlink: provider files written, state write skipped + warned', async () => {
    const repo = await setup({
      'AGENTS.md': '# Project standards\n\nUse npm test.\n',
      'cfg-agents/.keep': '',
    });
    await symlink('cfg-agents', join(repo.root, '.agents'));

    const report = await runApply(repo.root);
    assert.equal(report.exitCode, 0);
    assert.ok(report.written.includes('.github/copilot-instructions.md'));
    // The state baseline was skipped (not crashed into), with an HH-W013
    // naming the state path; nothing landed at the symlink's target.
    const warning = report.warnings.find(
      (w) => w.code === 'HH-W013' && w.message.includes(APPLY_STATE_PATH),
    );
    assert.notEqual(warning, undefined);
    assert.equal(existsSync(join(repo.root, 'cfg-agents', '.harness-state.json')), false);
  });
});
