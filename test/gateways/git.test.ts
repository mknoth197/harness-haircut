/**
 * `isWorkingTreeDirty` — INTEGRATION test (testing.md category 2). Runs
 * `git status --porcelain` against real tmp directories: a clean committed
 * repo, a repo with an untracked file, and a non-git directory (the
 * cannot-verify → dirty rule).
 *
 * `git` is required for these; on a machine without it (or where `git init`
 * fails) they are skipped rather than failing a contributor's run.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isWorkingTreeDirty } from '../../dist/index.js';
import { mkTempRepo } from '../_helpers/tmp-repo.ts';
import type { TempRepo } from '../_helpers/tmp-repo.ts';

const repos: TempRepo[] = [];
after(async () => {
  await Promise.all(repos.map((repo) => repo.cleanup()));
});

const GIT_AVAILABLE = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0;

function git(cwd: string, args: string[]): void {
  const r = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${args.join(' ')} failed: ${r.stderr}`);
}

async function initRepo(files: Record<string, string>): Promise<TempRepo> {
  const repo = await mkTempRepo(files);
  repos.push(repo);
  git(repo.root, ['init', '-q']);
  git(repo.root, ['config', 'user.email', 'test@example.com']);
  git(repo.root, ['config', 'user.name', 'Test']);
  git(repo.root, ['config', 'commit.gpgsign', 'false']);
  return repo;
}

describe('isWorkingTreeDirty()', () => {
  it('returns false for a fully committed (clean) tree', { skip: !GIT_AVAILABLE }, async () => {
    const repo = await initRepo({ 'a.txt': 'one\n' });
    git(repo.root, ['add', '-A']);
    git(repo.root, ['commit', '-q', '-m', 'init']);
    assert.equal(await isWorkingTreeDirty(repo.root), false);
  });

  it('returns true when an untracked file is present', { skip: !GIT_AVAILABLE }, async () => {
    const repo = await initRepo({ 'a.txt': 'one\n' });
    git(repo.root, ['add', '-A']);
    git(repo.root, ['commit', '-q', '-m', 'init']);
    await writeFile(join(repo.root, 'untracked.txt'), 'new\n', 'utf8');
    assert.equal(await isWorkingTreeDirty(repo.root), true);
  });

  it('returns true when a tracked file is modified', { skip: !GIT_AVAILABLE }, async () => {
    const repo = await initRepo({ 'a.txt': 'one\n' });
    git(repo.root, ['add', '-A']);
    git(repo.root, ['commit', '-q', '-m', 'init']);
    await writeFile(join(repo.root, 'a.txt'), 'changed\n', 'utf8');
    assert.equal(await isWorkingTreeDirty(repo.root), true);
  });

  it('returns true for a non-git directory (cannot verify → dirty)', async () => {
    const repo = await mkTempRepo({ 'a.txt': 'one\n' });
    repos.push(repo);
    assert.equal(await isWorkingTreeDirty(repo.root), true);
  });
});
