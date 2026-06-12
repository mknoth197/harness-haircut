/**
 * `createFileWriter` — INTEGRATION test against a real filesystem in
 * os.tmpdir() (testing.md category 2). Exercises write/read/exists and the
 * mkdirp behavior (parent directories are created on write).
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, lstatSync } from 'node:fs';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFileWriter, createSymlinkAliasProbe } from '../../dist/index.js';
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

  // SECURITY (FIX 2b): a relPath that escapes the repo root via `..` (or an
  // absolute path) must be rejected before any disk write.
  it('rejects a relPath that escapes the repo root via ..', async () => {
    const repo = await freshRepo();
    const writer = createFileWriter(repo.root);
    assert.throws(() => writer.write('../escape.txt', 'pwned\n'), /outside repo root/);
    assert.throws(() => writer.write('a/../../escape.txt', 'pwned\n'), /outside repo root/);
    // The escape target was never created.
    assert.equal(existsSync(join(repo.root, '..', 'escape.txt')), false);
  });

  it('rejects an absolute relPath', async () => {
    const repo = await freshRepo();
    const writer = createFileWriter(repo.root);
    assert.throws(() => writer.write('/etc/passwd', 'pwned\n'), /outside repo root/);
  });

  it('still writes a legitimate nested path inside the root', async () => {
    const repo = await freshRepo();
    const writer = createFileWriter(repo.root);
    writer.write('.agents/skills/x/SKILL.md', 'ok\n');
    assert.equal(writer.read('.agents/skills/x/SKILL.md'), 'ok\n');
  });

  // SECURITY (FIX 1, writer consistency): a symlinked target must read as
  // absent and never be followed; a write replaces the LINK with a real file
  // inside the repo rather than following it out to corrupt the target.
  it('treats a symlinked target as absent and replaces it on write (never follows)', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'harness-haircut-secret-'));
    const secretPath = join(outside, 'secret');
    await writeFile(secretPath, 'SECRET\n', 'utf8');

    const repo = await freshRepo();
    await symlink(secretPath, join(repo.root, 'CLAUDE.md'));
    const writer = createFileWriter(repo.root);

    // The link is not followed on read/exists.
    assert.equal(writer.read('CLAUDE.md'), null);
    assert.equal(writer.exists('CLAUDE.md'), false);

    // Writing replaces the symlink with a real file; the external secret is
    // left intact (the link target was not written through).
    writer.write('CLAUDE.md', '@AGENTS.md\n');
    assert.equal(writer.read('CLAUDE.md'), '@AGENTS.md\n');
    assert.equal(lstatSync(join(repo.root, 'CLAUDE.md')).isSymbolicLink(), false);
    assert.equal(await readFile(secretPath, 'utf8'), 'SECRET\n');

    await rm(outside, { recursive: true, force: true });
  });

  // BLOCKER 1 (live bypass, write side): the prior guard only lstat'd the LEAF,
  // so a write to `.github/x.md` where `.github` is a symlink to an external
  // dir would mkdir/write THROUGH the symlinked parent and clobber the external
  // file — landing outside the repo (violates U1 adapter-declared-paths). The
  // realpath-ancestor check now refuses the write before any disk mutation.
  it('refuses to write through a symlinked PARENT directory (no clobber outside repo)', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'harness-haircut-external-'));
    const externalFile = join(outside, 'copilot-instructions.md');
    await writeFile(externalFile, 'EXTERNAL-ORIGINAL\n', 'utf8');

    const repo = await freshRepo();
    // .github inside the repo is a symlink to the external dir.
    await symlink(outside, join(repo.root, '.github'));
    const writer = createFileWriter(repo.root);

    // The write must be refused — it would otherwise land at outside/...
    assert.throws(
      () => writer.write('.github/copilot-instructions.md', 'PROJECTED\n'),
      /escapes repo root|outside repo root/,
    );
    // The external file was NOT clobbered.
    assert.equal(await readFile(externalFile, 'utf8'), 'EXTERNAL-ORIGINAL\n');

    await rm(outside, { recursive: true, force: true });
  });

  it('still writes a legitimate deep path through real directories', async () => {
    const repo = await freshRepo();
    const writer = createFileWriter(repo.root);
    writer.write('.agents/skills/x/SKILL.md', 'ok\n');
    assert.equal(
      await readFile(join(repo.root, '.agents', 'skills', 'x', 'SKILL.md'), 'utf8'),
      'ok\n',
    );
  });

  // #35: an IN-REPO symlinked parent is just as dangerous as an escaping one —
  // the write lands on the link's target (on real repos, the canonical source).
  // The cerebro shape: .claude/skills/demo -> ../../.agents/skills/demo.
  it('refuses to write through an in-repo symlinked parent (canonical source untouched)', async () => {
    const canonical = '---\nname: demo\ndescription: d\nallowed-tools: "Read"\n---\nBody.\n';
    const repo = await freshRepo({
      '.agents/skills/demo/SKILL.md': canonical,
      // Seeds .claude/skills/ as a real directory (and a real-dir control).
      '.claude/skills/keep/SKILL.md': 'real\n',
    });
    await symlink(
      join('..', '..', '.agents', 'skills', 'demo'),
      join(repo.root, '.claude', 'skills', 'demo'),
    );
    const writer = createFileWriter(repo.root);
    writer.write('.claude/skills/keep/SKILL.md', 'real dir works\n'); // control: real dirs fine

    assert.throws(
      () => writer.write('.claude/skills/demo/SKILL.md', 'PROJECTION\n'),
      /in-repo symlinked parent/,
    );
    // The canonical source behind the symlink was NOT clobbered.
    assert.equal(
      await readFile(join(repo.root, '.agents', 'skills', 'demo', 'SKILL.md'), 'utf8'),
      canonical,
    );
  });
});

describe('createSymlinkAliasProbe()', () => {
  it('resolves a path behind an in-repo symlinked parent to its real repo path', async () => {
    const repo = await freshRepo({
      '.agents/skills/demo/SKILL.md': 'canonical\n',
      '.claude/skills/keep/SKILL.md': 'real\n',
    });
    await symlink(
      join('..', '..', '.agents', 'skills', 'demo'),
      join(repo.root, '.claude', 'skills', 'demo'),
    );
    const aliasOf = createSymlinkAliasProbe(repo.root);
    assert.equal(aliasOf('.claude/skills/demo/SKILL.md'), '.agents/skills/demo/SKILL.md');
    // A sibling through REAL directories is not aliased.
    assert.equal(aliasOf('.claude/skills/keep/SKILL.md'), null);
  });

  it('returns null for symlink-free paths, missing parents, and a symlinked LEAF', async () => {
    const repo = await freshRepo({ 'AGENTS.md': '# T\n', '.agents/skills/x/SKILL.md': 'c\n' });
    await symlink(join('.agents', 'skills', 'x', 'SKILL.md'), join(repo.root, 'LINK.md'));
    const aliasOf = createSymlinkAliasProbe(repo.root);
    assert.equal(aliasOf('AGENTS.md'), null);
    assert.equal(aliasOf('.claude/skills/new/SKILL.md'), null); // parents do not exist yet
    // The leaf being a symlink is write-safe (the link is replaced in place).
    assert.equal(aliasOf('LINK.md'), null);
  });

  it('reports an ESCAPING symlinked parent as aliased too (absolute target)', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'harness-haircut-ext-'));
    const repo = await freshRepo();
    await symlink(outside, join(repo.root, '.github'));
    const aliasOf = createSymlinkAliasProbe(repo.root);
    const resolved = aliasOf('.github/copilot-instructions.md');
    assert.notEqual(resolved, null);
    assert.equal(resolved !== null && resolved.startsWith('/'), true);
    await rm(outside, { recursive: true, force: true });
  });
});
