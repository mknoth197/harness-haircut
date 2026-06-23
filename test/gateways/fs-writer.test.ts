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

  // #37: `remove` displaces a recovered fragment original. Same containment as
  // `write`: delete the named file, no-op when absent, remove a symlinked LEAF
  // (not its target), and refuse to delete THROUGH a symlinked/escaping parent.
  it('removes a file and reports it absent afterward', async () => {
    const repo = await freshRepo({ '.github/instructions/security.instructions.md': 'x\n' });
    const writer = createFileWriter(repo.root);
    writer.remove('.github/instructions/security.instructions.md');
    assert.equal(writer.exists('.github/instructions/security.instructions.md'), false);
    assert.equal(
      existsSync(join(repo.root, '.github', 'instructions', 'security.instructions.md')),
      false,
    );
  });

  it('remove is a no-op for a missing file (idempotent, no throw)', async () => {
    const repo = await freshRepo();
    const writer = createFileWriter(repo.root);
    assert.doesNotThrow(() => writer.remove('never-existed.md'));
  });

  it('rejects a remove relPath that escapes the repo root (.. or absolute), target untouched', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'harness-haircut-rm-'));
    const victim = join(outside, 'victim.txt');
    await writeFile(victim, 'KEEP\n', 'utf8');
    const repo = await freshRepo();
    const writer = createFileWriter(repo.root);
    assert.throws(() => writer.remove('a/../../escape.txt'), /outside repo root/);
    assert.throws(() => writer.remove(victim), /outside repo root/);
    assert.equal(await readFile(victim, 'utf8'), 'KEEP\n');
    await rm(outside, { recursive: true, force: true });
  });

  it('removes a symlinked LEAF itself, never its target', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'harness-haircut-rmleaf-'));
    const target = join(outside, 'keep.txt');
    await writeFile(target, 'KEEP\n', 'utf8');
    const repo = await freshRepo();
    await symlink(target, join(repo.root, 'link.md'));
    const writer = createFileWriter(repo.root);
    writer.remove('link.md');
    assert.equal(existsSync(join(repo.root, 'link.md')), false); // the link is gone
    assert.equal(await readFile(target, 'utf8'), 'KEEP\n'); // its target is intact
    await rm(outside, { recursive: true, force: true });
  });

  it('refuses to remove through a symlinked PARENT directory (no external delete)', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'harness-haircut-rmparent-'));
    const externalFile = join(outside, 'instructions.md');
    await writeFile(externalFile, 'EXTERNAL\n', 'utf8');
    const repo = await freshRepo();
    await symlink(outside, join(repo.root, '.github'));
    const writer = createFileWriter(repo.root);
    assert.throws(
      () => writer.remove('.github/instructions.md'),
      /escapes repo root|outside repo root|symlinked parent/,
    );
    assert.equal(await readFile(externalFile, 'utf8'), 'EXTERNAL\n');
    await rm(outside, { recursive: true, force: true });
  });

  // Submodule boundaries (CRITICAL), defense-in-depth: even if a path slips
  // past the snapshot walk's submodule boundary (a hand-built EmittedFile, a
  // future caller), the writer must NEVER land a file inside a submodule tree.
  // The dogfood bug: `apply` wrote references/sdlc-next/CLAUDE.md INSIDE the
  // pinned submodule. `.gitmodules` is read once at construction.
  it('refuses to write a file under a declared submodule root (submodule content untouched)', async () => {
    const repo = await freshRepo({
      '.gitmodules': '[submodule "references/sdlc-next"]\n\tpath = references/sdlc-next\n',
      'references/sdlc-next/AGENTS.md': '# submodule canonical\n',
    });
    const writer = createFileWriter(repo.root);
    assert.throws(
      () => writer.write('references/sdlc-next/CLAUDE.md', '@AGENTS.md\n'),
      /submodule/,
    );
    // Nothing was written inside the submodule, and its own files are intact.
    assert.equal(existsSync(join(repo.root, 'references', 'sdlc-next', 'CLAUDE.md')), false);
    assert.equal(
      await readFile(join(repo.root, 'references', 'sdlc-next', 'AGENTS.md'), 'utf8'),
      '# submodule canonical\n',
    );
  });

  it('refuses to write the submodule root path itself', async () => {
    const repo = await freshRepo({ '.gitmodules': '[submodule "s"]\n\tpath = sub/s\n' });
    const writer = createFileWriter(repo.root);
    assert.throws(() => writer.write('sub/s', 'x\n'), /submodule/);
  });

  // Regression for the `..`-traversal bypass: a path like
  // `foo/../references/sdlc-next/CLAUDE.md` is in-repo (assertContained passes)
  // and the OS collapses `..` AT WRITE TIME so the file lands INSIDE the
  // submodule — but the boundary check used to compare the raw POSIX string,
  // where the literal `..` never matched the submodule prefix, so the write
  // slipped through. The guard must compare the RESOLVED destination.
  it('refuses to write under a submodule via a `..`-traversal path (resolved, not lexical)', async () => {
    const repo = await freshRepo({
      '.gitmodules': '[submodule "references/sdlc-next"]\n\tpath = references/sdlc-next\n',
      'references/sdlc-next/AGENTS.md': '# submodule canonical\n',
    });
    const writer = createFileWriter(repo.root);
    assert.throws(
      () => writer.write('foo/../references/sdlc-next/CLAUDE.md', '@AGENTS.md\n'),
      /submodule/,
    );
    // Deeper traversal that resolves to the same in-submodule location.
    assert.throws(
      () => writer.write('a/x/../../references/sdlc-next/EVIL.md', 'evil\n'),
      /submodule/,
    );
    // Nothing landed inside the submodule, and its own files are intact.
    assert.equal(existsSync(join(repo.root, 'references', 'sdlc-next', 'CLAUDE.md')), false);
    assert.equal(existsSync(join(repo.root, 'references', 'sdlc-next', 'EVIL.md')), false);
    assert.equal(
      await readFile(join(repo.root, 'references', 'sdlc-next', 'AGENTS.md'), 'utf8'),
      '# submodule canonical\n',
    );
  });

  // REGRESSION (#3 realpath, not lexical): a write through an in-repo symlink
  // ALIAS — `alias -> references`, `references/sdlc-next` a submodule — lands
  // PHYSICALLY inside the submodule, but the old guard compared a merely lexical
  // `resolve()` (which collapses `..` but NOT symlinks), so `alias/sdlc-next/X`
  // never matched the `references/sdlc-next` prefix. It was only incidentally
  // blocked by the #35 parent-containment check, with an unrelated message. The
  // guard now realpaths the parent chain, so an aliased submodule write is
  // refused with the clear SUBMODULE message.
  it('refuses to write under a submodule via an in-repo symlink ALIAS (realpath, not lexical)', async () => {
    const repo = await freshRepo({
      '.gitmodules': '[submodule "references/sdlc-next"]\n\tpath = references/sdlc-next\n',
      'references/sdlc-next/AGENTS.md': '# submodule canonical\n',
    });
    // `alias` is an in-repo symlink to the real `references` directory, so
    // `alias/sdlc-next` resolves to the submodule `references/sdlc-next`.
    await symlink('references', join(repo.root, 'alias'));
    const writer = createFileWriter(repo.root);
    assert.throws(
      () => writer.write('alias/sdlc-next/CLAUDE.md', '@AGENTS.md\n'),
      /submodule/,
    );
    assert.throws(
      () => writer.remove('alias/sdlc-next/AGENTS.md'),
      /submodule/,
    );
    // Nothing landed inside the submodule and its own file is intact.
    assert.equal(existsSync(join(repo.root, 'references', 'sdlc-next', 'CLAUDE.md')), false);
    assert.equal(
      await readFile(join(repo.root, 'references', 'sdlc-next', 'AGENTS.md'), 'utf8'),
      '# submodule canonical\n',
    );
  });

  it('refuses to remove under a submodule via a `..`-traversal path', async () => {
    const repo = await freshRepo({
      '.gitmodules': '[submodule "s"]\n\tpath = sub/s\n',
      'sub/s/SKILL.md': 'submodule file\n',
    });
    const writer = createFileWriter(repo.root);
    assert.throws(() => writer.remove('sub/q/../s/SKILL.md'), /submodule/);
    assert.equal(existsSync(join(repo.root, 'sub', 's', 'SKILL.md')), true);
  });

  // The fix must not over-block: a `..`-traversal that resolves to a NON-submodule
  // path (sub/server, prefix-shares with submodule sub/s) still writes fine.
  it('still writes a `..`-traversal path that resolves OUTSIDE any submodule', async () => {
    const repo = await freshRepo({ '.gitmodules': '[submodule "s"]\n\tpath = sub/s\n' });
    const writer = createFileWriter(repo.root);
    writer.write('sub/tmp/../server/AGENTS.md', '# not a submodule\n');
    assert.equal(writer.read('sub/server/AGENTS.md'), '# not a submodule\n');
  });

  it('refuses to remove a path under a declared submodule root', async () => {
    const repo = await freshRepo({
      '.gitmodules': '[submodule "s"]\n\tpath = sub/s\n',
      'sub/s/SKILL.md': 'submodule file\n',
    });
    const writer = createFileWriter(repo.root);
    assert.throws(() => writer.remove('sub/s/SKILL.md'), /submodule/);
    // The submodule file was NOT deleted.
    assert.equal(existsSync(join(repo.root, 'sub', 's', 'SKILL.md')), true);
  });

  it('still writes a sibling path that is NOT under any submodule', async () => {
    // A directory whose name merely shares a PREFIX with the submodule path
    // (sub/server vs submodule sub/s) must not be falsely blocked.
    const repo = await freshRepo({ '.gitmodules': '[submodule "s"]\n\tpath = sub/s\n' });
    const writer = createFileWriter(repo.root);
    writer.write('sub/server/AGENTS.md', '# not a submodule\n');
    assert.equal(writer.read('sub/server/AGENTS.md'), '# not a submodule\n');
    // And the parent's own canonical write still works.
    writer.write('.github/instructions/hh.foo.instructions.md', 'body\n');
    assert.equal(writer.read('.github/instructions/hh.foo.instructions.md'), 'body\n');
  });

  it('writes normally when the repo has no .gitmodules (no regression)', async () => {
    const repo = await freshRepo();
    const writer = createFileWriter(repo.root);
    writer.write('references/sdlc-next/CLAUDE.md', '@AGENTS.md\n');
    assert.equal(writer.read('references/sdlc-next/CLAUDE.md'), '@AGENTS.md\n');
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
