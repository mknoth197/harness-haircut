import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile, stat, rm, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPrecommitGateway } from '../../dist/gateways/precommit.js';
import { installPrecommit, PRECOMMIT_COMMAND } from '../../dist/use-cases/install-precommit.js';

const tempDirs: string[] = [];
after(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

/** A throwaway repo with a real `.git` directory (and optionally `.husky`). */
async function mkRepo(opts?: { husky?: boolean; git?: boolean }): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'harness-precommit-'));
  tempDirs.push(root);
  if (opts?.git ?? true) {
    await mkdir(join(root, '.git', 'hooks'), { recursive: true });
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

  it('exits 3 when there is no .git directory (UN1)', async () => {
    const root = await mkRepo({ git: false });
    const report = installPrecommit({
      gateway: createPrecommitGateway(root),
      flags: { force: false },
    });
    assert.equal(report.exitCode, 3);
  });
});
