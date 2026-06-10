import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, stat, rm, mkdtemp } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { createPrecommitGateway } from '../../dist/gateways/precommit.js';
import { installPrecommit, PRECOMMIT_COMMAND } from '../../dist/use-cases/install-precommit.js';

const tempDirs: string[] = [];
after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/**
 * A throwaway repo. By default it is a REAL git repo (`git init`) so the
 * gateway's `git rev-parse --git-path hooks` resolves; `git: false` leaves a
 * bare tmpdir with no repo (the not-a-git-repo case).
 */
async function mkRepo(opts?: { husky?: boolean; git?: boolean }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'harness-precommit-'));
  tempDirs.push(root);
  if (opts?.git ?? true) {
    execFileSync('git', ['init', '-q'], { cwd: root });
  }
  if (opts?.husky) {
    await mkdir(join(root, '.husky'), { recursive: true });
  }
  return root;
}

describe('createPrecommitGateway() + installPrecommit() over a real repo', () => {
  it('detects husky and writes .husky/pre-commit (EV1)', async () => {
    const root = await mkRepo({ husky: true });
    const report = installPrecommit({
      gateway: createPrecommitGateway(root),
      flags: { force: false },
    });
    assert.equal(report.target, '.husky/pre-commit');
    const content = await readFile(join(root, '.husky', 'pre-commit'), 'utf8');
    assert.match(content, /npx harness-haircut audit --json/);
  });

  it('writes .git/hooks/pre-commit with the exec bit set (EV2)', async () => {
    const root = await mkRepo();
    const report = installPrecommit({
      gateway: createPrecommitGateway(root),
      flags: { force: false },
    });
    assert.equal(report.target, '.git/hooks/pre-commit');
    const hookPath = join(root, '.git', 'hooks', 'pre-commit');
    const content = await readFile(hookPath, 'utf8');
    assert.match(content, new RegExp(PRECOMMIT_COMMAND.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });

  // chmod is a no-op on Windows (mode bits synthesized from extension), so the
  // exec-bit assertion only holds on POSIX — same gate the postbuild test uses.
  it(
    '.git/hooks/pre-commit is executable (EV2)',
    { skip: process.platform === 'win32' },
    async () => {
      const root = await mkRepo();
      installPrecommit({ gateway: createPrecommitGateway(root), flags: { force: false } });
      const mode = (await stat(join(root, '.git', 'hooks', 'pre-commit'))).mode;
      assert.notEqual(mode & 0o111, 0);
    },
  );

  it('appends to an existing hook and stays idempotent across re-runs (OPT1)', async () => {
    const root = await mkRepo();
    const hookPath = join(root, '.git', 'hooks', 'pre-commit');
    await writeFile(hookPath, '#!/usr/bin/env sh\nnpm run lint\n', 'utf8');

    const first = installPrecommit({
      gateway: createPrecommitGateway(root),
      flags: { force: false },
    });
    assert.equal(first.action, 'appended');

    const second = installPrecommit({
      gateway: createPrecommitGateway(root),
      flags: { force: false },
    });
    assert.equal(second.action, 'unchanged');

    const content = await readFile(hookPath, 'utf8');
    assert.match(content, /npm run lint/); // preserved
    // Block appears exactly once after two runs.
    const matches = content.match(/harness-haircut audit --json/g) ?? [];
    assert.equal(matches.length, 1);
  });

  it('overwrites with --force (OPT1)', async () => {
    const root = await mkRepo();
    const hookPath = join(root, '.git', 'hooks', 'pre-commit');
    await writeFile(hookPath, '#!/usr/bin/env sh\nnpm run lint\n', 'utf8');
    const report = installPrecommit({
      gateway: createPrecommitGateway(root),
      flags: { force: true },
    });
    assert.equal(report.action, 'overwritten');
    const content = await readFile(hookPath, 'utf8');
    assert.doesNotMatch(content, /npm run lint/);
  });

  it('exits 3 when there is no git repo to resolve (UN1)', async () => {
    const root = await mkRepo({ git: false });
    const report = installPrecommit({
      gateway: createPrecommitGateway(root),
      flags: { force: false },
    });
    assert.equal(report.exitCode, 3);
  });

  it('installs in a worktree where .git is a FILE — no ENOTDIR/exit 70 (EV2)', async () => {
    const main = await mkRepo();
    // A commit is required before `git worktree add`.
    execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init', '--allow-empty'], {
      cwd: main,
    });
    const wt = await mkdtemp(join(tmpdir(), 'harness-precommit-wt-'));
    tempDirs.push(wt);
    // `git worktree add` wants a non-existent path; remove the empty mkdtemp dir.
    await rm(wt, { recursive: true, force: true });
    execFileSync('git', ['worktree', 'add', '-q', wt], { cwd: main });

    // `.git` in the worktree is a gitlink FILE, not a directory.
    const dotGit = await readFile(join(wt, '.git'), 'utf8');
    assert.equal(dotGit.startsWith('gitdir:'), true);

    const report = installPrecommit({
      gateway: createPrecommitGateway(wt),
      flags: { force: false },
    });
    assert.equal(report.exitCode, 0);
    assert.match(report.target, /pre-commit$/);
    // `git rev-parse --git-path hooks` reports an absolute path in a worktree;
    // the gateway honors it verbatim, so read it directly.
    const hookPath = isAbsolute(report.target) ? report.target : join(wt, report.target);
    const content = await readFile(hookPath, 'utf8');
    assert.match(content, new RegExp(PRECOMMIT_COMMAND.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
  });
});
