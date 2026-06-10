/**
 * `createFileWriter` — INTEGRATION test against a real filesystem in
 * os.tmpdir() (testing.md category 2). Exercises write/read/exists and the
 * mkdirp behavior (parent directories are created on write).
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createFileWriter } from '../../dist/index.js';
import { mkTempRepo } from '../_helpers/tmp-repo.ts';
import type { TempRepo } from '../_helpers/tmp-repo.ts';

const repos: TempRepo[] = [];
after(async () => {
  await Promise.all(repos.map((repo) => repo.cleanup()));
});

async function freshRepo(files: Record<string, string> = {}): Promise<TempRepo> {
  const repo = await mkTempRepo(files);
  repos.push(repo);
  return repo;
}

describe('createFileWriter()', () => {
  it('writes a file and reads it back', async () => {
    const repo = await freshRepo();
    const writer = createFileWriter(repo.root);
    writer.write('top.txt', 'hello\n');
    assert.equal(writer.read('top.txt'), 'hello\n');
    assert.equal(await readFile(join(repo.root, 'top.txt'), 'utf8'), 'hello\n');
  });

  it('creates parent directories (mkdirp) when writing a nested path', async () => {
    const repo = await freshRepo();
    const writer = createFileWriter(repo.root);
    writer.write('.github/instructions/hh.foo.md', 'body\n');
    assert.equal(
      await readFile(join(repo.root, '.github', 'instructions', 'hh.foo.md'), 'utf8'),
      'body\n',
    );
  });

  it('replaces an existing file wholesale (no append)', async () => {
    const repo = await freshRepo({ 'a.txt': 'old\n' });
    const writer = createFileWriter(repo.root);
    writer.write('a.txt', 'new\n');
    assert.equal(writer.read('a.txt'), 'new\n');
  });

  it('read returns null for a missing file', async () => {
    const repo = await freshRepo();
    const writer = createFileWriter(repo.root);
    assert.equal(writer.read('nope.txt'), null);
  });

  it('read returns null for a directory at the path', async () => {
    const repo = await freshRepo({ 'dir/child.txt': 'x\n' });
    const writer = createFileWriter(repo.root);
    assert.equal(writer.read('dir'), null);
  });

  it('exists is true only for an existing file, false for missing and for a dir', async () => {
    const repo = await freshRepo({ 'present.txt': 'x\n', 'dir/child.txt': 'y\n' });
    const writer = createFileWriter(repo.root);
    assert.equal(writer.exists('present.txt'), true);
    assert.equal(writer.exists('missing.txt'), false);
    assert.equal(writer.exists('dir'), false);
  });
});
