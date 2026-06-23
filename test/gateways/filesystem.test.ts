import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readRepoSnapshot, readInitSnapshot } from '../../dist/index.js';
import { isIgnored, parseGitignore, parseGitmodules } from '../../dist/gateways/filesystem.js';
import { mkTempRepo } from '../_helpers/tmp-repo.ts';

function paths(files: ReadonlyArray<{ path: string }>): string[] {
  return files.map((file) => file.path);
}

/** Pure-matcher convenience: compile `gitignore` and test one path. */
function ignored(gitignore: string, relPath: string, isDir = false): boolean {
  return isIgnored(relPath, isDir, parseGitignore(gitignore));
}

describe('readRepoSnapshot', () => {
  it('collects root AGENTS.md, nested AGENTS.md, and .agents/** files, sorted', async () => {
    const repo = await mkTempRepo({
      'AGENTS.md': '# root',
      'pkg/web/AGENTS.md': '# nested',
      '.agents/instructions/arch.md': '---\nscope: "src/**"\n---\nbody',
      '.agents/skills/deploy/SKILL.md': 'skill',
      'README.md': 'not canonical',
      'src/index.ts': 'export {};',
    });
    try {
      const snapshot = await readRepoSnapshot(repo.root);
      assert.equal(snapshot.root, repo.root);
      assert.deepEqual(paths(snapshot.files), [
        '.agents/instructions/arch.md',
        '.agents/skills/deploy/SKILL.md',
        'AGENTS.md',
        'pkg/web/AGENTS.md',
      ]);
      assert.equal(snapshot.files[2]?.content, '# root');
    } finally {
      await repo.cleanup();
    }
  });

  it('always skips .git/, node_modules/, and dist/ at any depth', async () => {
    const repo = await mkTempRepo({
      'AGENTS.md': '# root',
      '.git/AGENTS.md': 'never',
      'node_modules/dep/AGENTS.md': 'never',
      'dist/AGENTS.md': 'never',
      'pkg/node_modules/dep/AGENTS.md': 'never',
    });
    try {
      const snapshot = await readRepoSnapshot(repo.root);
      assert.deepEqual(paths(snapshot.files), ['AGENTS.md']);
    } finally {
      await repo.cleanup();
    }
  });

  it('honors simple-name and *-wildcard .gitignore patterns against basenames', async () => {
    const repo = await mkTempRepo({
      '.gitignore': '# comment\n\n*.log\ntmp-*\n',
      'AGENTS.md': '# root',
      '.agents/debug.log': 'ignored',
      '.agents/tmp-scratch.md': 'ignored',
      '.agents/instructions/arch.md': '---\nscope: "src/**"\n---\nbody',
    });
    try {
      const snapshot = await readRepoSnapshot(repo.root);
      assert.deepEqual(paths(snapshot.files), ['.agents/instructions/arch.md', 'AGENTS.md']);
    } finally {
      await repo.cleanup();
    }
  });

  it('prunes directories matched by dir/ patterns and keeps same-named files', async () => {
    const repo = await mkTempRepo({
      '.gitignore': 'scratch/\n',
      'AGENTS.md': '# root',
      '.agents/scratch/notes.md': 'ignored with the directory',
    });
    try {
      const snapshot = await readRepoSnapshot(repo.root);
      assert.deepEqual(paths(snapshot.files), ['AGENTS.md']);
    } finally {
      await repo.cleanup();
    }

    const fileRepo = await mkTempRepo({
      '.gitignore': 'scratch/\n',
      '.agents/scratch': 'a plain file named scratch survives a dir-only pattern',
    });
    try {
      const snapshot = await readRepoSnapshot(fileRepo.root);
      assert.deepEqual(paths(snapshot.files), ['.agents/scratch']);
    } finally {
      await fileRepo.cleanup();
    }
  });

  it('anchors patterns containing a slash to the repo root', async () => {
    const repo = await mkTempRepo({
      '.gitignore': 'docs/AGENTS.md\n',
      'AGENTS.md': '# root',
      'docs/AGENTS.md': 'ignored — anchored match',
      'sub/docs/AGENTS.md': 'kept — anchored pattern does not match deeper paths',
    });
    try {
      const snapshot = await readRepoSnapshot(repo.root);
      assert.deepEqual(paths(snapshot.files), ['AGENTS.md', 'sub/docs/AGENTS.md']);
    } finally {
      await repo.cleanup();
    }
  });

  it('works without a .gitignore', async () => {
    const repo = await mkTempRepo({ 'AGENTS.md': '# root' });
    try {
      const snapshot = await readRepoSnapshot(repo.root);
      assert.deepEqual(paths(snapshot.files), ['AGENTS.md']);
    } finally {
      await repo.cleanup();
    }
  });

  it('does not collect nested .agents/ directories (root .agents/ only)', async () => {
    const repo = await mkTempRepo({
      'AGENTS.md': '# root',
      '.agents/skills/deploy/SKILL.md': '---\nname: deploy\ndescription: d\n---\n',
      'pkg/.agents/skills/nested/SKILL.md': 'nested .agents trees are not canonical today',
    });
    try {
      const snapshot = await readRepoSnapshot(repo.root);
      assert.deepEqual(paths(snapshot.files), ['.agents/skills/deploy/SKILL.md', 'AGENTS.md']);
    } finally {
      await repo.cleanup();
    }
  });

  it('strips a leading UTF-8 BOM from file contents', async () => {
    const repo = await mkTempRepo({ 'AGENTS.md': '\uFEFF# root' });
    try {
      const snapshot = await readRepoSnapshot(repo.root);
      assert.equal(snapshot.files[0]?.content, '# root');
    } finally {
      await repo.cleanup();
    }
  });

  it('re-includes a canonical source via a later negation line', async () => {
    const repo = await mkTempRepo({
      '.gitignore': '*.md\n!AGENTS.md\n',
      'AGENTS.md': '# root',
      'pkg/AGENTS.md': '# nested',
      'README.md': 'still ignored',
    });
    try {
      const snapshot = await readRepoSnapshot(repo.root);
      // Negation re-includes the AGENTS.md files; *.md still hides README.md
      // (which is not canonical anyway), and no HH-W012 fires for AGENTS.md.
      assert.deepEqual(paths(snapshot.files), ['AGENTS.md', 'pkg/AGENTS.md']);
      assert.deepEqual(snapshot.excludedCanonicalPaths ?? [], []);
    } finally {
      await repo.cleanup();
    }
  });

  it('honors multi-segment ** patterns during the walk', async () => {
    const repo = await mkTempRepo({
      'AGENTS.md': '# root',
      // trailing /** prunes everything strictly inside .agents/skills/old/
      '.gitignore': '**/*.bak\n.agents/skills/old/**\n',
      '.agents/instructions/keep.md': '---\nscope: "src/**"\n---\nkeep',
      '.agents/instructions/scratch.bak': 'ignored at any depth via **/*.bak',
      '.agents/skills/old/SKILL.md': 'pruned by trailing /**',
    });
    try {
      const snapshot = await readRepoSnapshot(repo.root);
      assert.deepEqual(paths(snapshot.files), ['.agents/instructions/keep.md', 'AGENTS.md']);
    } finally {
      await repo.cleanup();
    }
  });

  it('records a directly-ignored AGENTS.md in excludedCanonicalPaths', async () => {
    const repo = await mkTempRepo({
      '.gitignore': '*.md\n',
      'AGENTS.md': '# root — ignored by *.md',
      'pkg/AGENTS.md': '# nested — also ignored',
    });
    try {
      const snapshot = await readRepoSnapshot(repo.root);
      assert.deepEqual(paths(snapshot.files), []);
      assert.deepEqual(snapshot.excludedCanonicalPaths, ['AGENTS.md', 'pkg/AGENTS.md']);
    } finally {
      await repo.cleanup();
    }
  });

  it('records the root .agents/ subtree when the whole directory is ignored', async () => {
    const repo = await mkTempRepo({
      '.gitignore': '.agents/\n',
      'AGENTS.md': '# root survives',
      '.agents/instructions/arch.md': '---\nscope: "src/**"\n---\nbody',
      '.agents/skills/deploy/SKILL.md': '---\nname: deploy\ndescription: d\n---\n',
    });
    try {
      const snapshot = await readRepoSnapshot(repo.root);
      assert.deepEqual(paths(snapshot.files), ['AGENTS.md']);
      assert.deepEqual(snapshot.excludedCanonicalPaths, ['.agents/']);
    } finally {
      await repo.cleanup();
    }
  });

  it('records a canonical-shaped .agents/ file excluded by an ignore rule', async () => {
    // EV1 is intentionally broad: anything under .agents/ is canonical-shaped,
    // so ignoring one earns HH-W012 (the tool no longer sees it). A genuinely
    // scratch file belongs outside .agents/, or the warning can be suppressed.
    const repo = await mkTempRepo({
      '.gitignore': '*.log\n',
      'AGENTS.md': '# root',
      '.agents/debug.log': 'ignored canonical-shaped path → HH-W012',
    });
    try {
      const snapshot = await readRepoSnapshot(repo.root);
      assert.deepEqual(paths(snapshot.files), ['AGENTS.md']);
      assert.deepEqual(snapshot.excludedCanonicalPaths, ['.agents/debug.log']);
    } finally {
      await repo.cleanup();
    }
  });

  it('records nothing when no canonical-shaped path is ignored', async () => {
    const repo = await mkTempRepo({
      '.gitignore': 'build/\n*.tmp\n',
      'AGENTS.md': '# root',
      'build/out.js': 'ignored, not canonical',
      'scratch.tmp': 'ignored, not canonical',
    });
    try {
      const snapshot = await readRepoSnapshot(repo.root);
      assert.deepEqual(paths(snapshot.files), ['AGENTS.md']);
      assert.deepEqual(snapshot.excludedCanonicalPaths ?? [], []);
    } finally {
      await repo.cleanup();
    }
  });
});

// #41: OS/editor noise + lockfiles are never canonical content. The original
// dogfood bug: a global `.DS_Store` rule made `.agents/.DS_Store` fire HH-W012
// advising the user to un-ignore their Finder junk. They must be skipped before
// the ignore check — collected by neither the snapshot nor the W012 tracker.
describe('readRepoSnapshot — #41 OS-junk / lockfile denylist', () => {
  it('does not collect a gitignored .agents/.DS_Store nor surface HH-W012 (the dogfood repro)', async () => {
    const repo = await mkTempRepo({
      '.gitignore': '.DS_Store\n',
      'AGENTS.md': '# root',
      '.agents/.DS_Store': 'macOS Finder junk',
      '.agents/instructions/arch.md': '---\nscope: "src/**"\n---\nbody',
    });
    try {
      const snapshot = await readRepoSnapshot(repo.root);
      assert.deepEqual(paths(snapshot.files), ['.agents/instructions/arch.md', 'AGENTS.md']);
      assert.deepEqual(snapshot.excludedCanonicalPaths ?? [], []);
    } finally {
      await repo.cleanup();
    }
  });

  it('does not collect OS junk under .agents/ even when NOT gitignored (no HH-W010 attachment)', async () => {
    const repo = await mkTempRepo({
      'AGENTS.md': '# root',
      '.agents/.DS_Store': 'macOS Finder junk',
      '.agents/skills/foo/Thumbs.db': 'Windows thumbnail cache',
      '.agents/skills/foo/SKILL.md': '---\nname: foo\ndescription: d\n---\n',
      '.agents/instructions/arch.swp': 'vim swap file',
    });
    try {
      const snapshot = await readRepoSnapshot(repo.root);
      assert.deepEqual(paths(snapshot.files), ['.agents/skills/foo/SKILL.md', 'AGENTS.md']);
      assert.deepEqual(snapshot.excludedCanonicalPaths ?? [], []);
    } finally {
      await repo.cleanup();
    }
  });

  it('does not advise un-ignoring a gitignored lockfile inside a skill dir', async () => {
    const repo = await mkTempRepo({
      '.gitignore': 'package-lock.json\n',
      'AGENTS.md': '# root',
      '.agents/skills/foo/SKILL.md': '---\nname: foo\ndescription: d\n---\n',
      '.agents/skills/foo/package-lock.json': '{"lockfileVersion":3}',
    });
    try {
      const snapshot = await readRepoSnapshot(repo.root);
      assert.deepEqual(paths(snapshot.files), ['.agents/skills/foo/SKILL.md', 'AGENTS.md']);
      assert.deepEqual(snapshot.excludedCanonicalPaths ?? [], []);
    } finally {
      await repo.cleanup();
    }
  });

  it('skips a *.lock file (Cargo.lock) under a skill dir, but keeps the SKILL.md (gauntlet)', async () => {
    const repo = await mkTempRepo({
      'AGENTS.md': '# root',
      '.agents/skills/foo/SKILL.md': '---\nname: foo\ndescription: d\n---\n',
      '.agents/skills/foo/Cargo.lock': '# rust lockfile, not content',
    });
    try {
      const snapshot = await readRepoSnapshot(repo.root);
      assert.deepEqual(paths(snapshot.files), ['.agents/skills/foo/SKILL.md', 'AGENTS.md']);
      assert.deepEqual(snapshot.excludedCanonicalPaths ?? [], []);
    } finally {
      await repo.cleanup();
    }
  });

  it('does NOT prune a tracked directory whose name ends in a junk suffix (gauntlet: suffixes are file-only)', async () => {
    // The editor-suffix denylist (.swp/.swo/~/.lock) describes FILES; a real
    // directory named `notes~` or `vendor.lock` (with canonical content under
    // it) must still be walked — pruning it would silently drop the content.
    const repo = await mkTempRepo({
      'AGENTS.md': '# root',
      'notes~/AGENTS.md': '# nested under a tilde-suffixed dir',
      'vendor.lock/AGENTS.md': '# nested under a .lock-suffixed dir',
      '.agents/instructions/scratch.swp': 'vim swap FILE — still skipped',
      '.agents/instructions/keep.md': '---\nscope: "src/**"\n---\nkeep',
    });
    try {
      const snapshot = await readRepoSnapshot(repo.root);
      assert.deepEqual(paths(snapshot.files), [
        '.agents/instructions/keep.md',
        'AGENTS.md',
        'notes~/AGENTS.md',
        'vendor.lock/AGENTS.md',
      ]);
      // The swap FILE was still skipped (suffix applies to files); no W012/W010.
      assert.deepEqual(snapshot.excludedCanonicalPaths ?? [], []);
    } finally {
      await repo.cleanup();
    }
  });
});

// #42: the `exclude` config glob list drops matches from canonical collection
// BEFORE the ignore check, so a tracked fixture's provider file is neither
// collected (→ not detected, not parsed, not projected into) nor surfaced as a
// lost canonical source (no HH-W012 — the exclusion is explicit, not accidental).
describe('readRepoSnapshot — #42 exclude config globs', () => {
  it('drops a tracked fixture AGENTS.md and fires no HH-W012', async () => {
    const repo = await mkTempRepo({
      'AGENTS.md': '# root',
      'evals/fixtures/codex/cerebro-skill/AGENTS.md': '# Fixture\n\nFixture content.\n',
      'evals/fixtures/codex/cerebro-skill-partial/AGENTS.md': '# Partial fixture\n',
    });
    try {
      const snapshot = await readRepoSnapshot(repo.root, ['evals/fixtures/**']);
      assert.deepEqual(paths(snapshot.files), ['AGENTS.md']);
      // The fixture AGENTS.md files are canonical-SHAPED, but excluded by config
      // is an explicit "not canonical" — never an HH-W012 "un-ignore it".
      assert.deepEqual(snapshot.excludedCanonicalPaths ?? [], []);
    } finally {
      await repo.cleanup();
    }
  });

  it('collects the fixture AGENTS.md when no exclude glob is configured (default)', async () => {
    const repo = await mkTempRepo({
      'AGENTS.md': '# root',
      'evals/fixtures/codex/cerebro-skill/AGENTS.md': '# Fixture\n',
    });
    try {
      const snapshot = await readRepoSnapshot(repo.root);
      assert.deepEqual(paths(snapshot.files), [
        'AGENTS.md',
        'evals/fixtures/codex/cerebro-skill/AGENTS.md',
      ]);
    } finally {
      await repo.cleanup();
    }
  });

  it('a single-segment exclude name drops a directory subtree at any depth', async () => {
    const repo = await mkTempRepo({
      'AGENTS.md': '# root',
      'pkg/__fixtures__/AGENTS.md': '# fixture',
      'pkg/real/AGENTS.md': '# real nested',
    });
    try {
      // Unanchored basename match (gitignore subset): `__fixtures__` matches the
      // dir at any depth; the real nested AGENTS.md is untouched.
      const snapshot = await readRepoSnapshot(repo.root, ['__fixtures__']);
      assert.deepEqual(paths(snapshot.files), ['AGENTS.md', 'pkg/real/AGENTS.md']);
      assert.deepEqual(snapshot.excludedCanonicalPaths ?? [], []);
    } finally {
      await repo.cleanup();
    }
  });
});

// #45: the walk never follows a symlink, so a symlinked provider file/dir is
// invisible to import. It must be RECORDED (skippedSymlinks) so init can note
// the skip rather than dropping it silently.
describe('readInitSnapshot / readRepoSnapshot — #45 skipped symlinks', () => {
  it('records a symlinked .claude/skills entry without following it (init snapshot)', async () => {
    const repo = await mkTempRepo({
      'AGENTS.md': '# root',
      'elsewhere/demo/SKILL.md': '---\nname: demo\ndescription: d\n---\nBody.\n',
      '.claude/skills/keep.md': 'placeholder to create the dir\n',
    });
    try {
      await symlink(join('..', '..', 'elsewhere', 'demo'), join(repo.root, '.claude', 'skills', 'demo'));
      const snapshot = await readInitSnapshot(repo.root);
      assert.deepEqual(snapshot.skippedSymlinks, ['.claude/skills/demo']);
      // The symlink's content is NOT collected (the walk never follows it).
      assert.equal(snapshot.files.some((f) => f.path.startsWith('.claude/skills/demo')), false);
    } finally {
      await repo.cleanup();
    }
  });

  it('records a symlinked canonical .agents/ entry (repo snapshot) and does not follow it', async () => {
    const repo = await mkTempRepo({
      'AGENTS.md': '# root',
      '.agents/skills/real/SKILL.md': '---\nname: real\ndescription: d\n---\n',
    });
    try {
      await symlink(join('..', 'real'), join(repo.root, '.agents', 'skills', 'linked'));
      const snapshot = await readRepoSnapshot(repo.root);
      assert.ok((snapshot.skippedSymlinks ?? []).includes('.agents/skills/linked'));
      assert.equal(snapshot.files.some((f) => f.path.startsWith('.agents/skills/linked')), false);
    } finally {
      await repo.cleanup();
    }
  });

  it('does not record a symlink the user gitignored (skipped quietly)', async () => {
    const repo = await mkTempRepo({
      '.gitignore': '.claude/skills/demo\n',
      'AGENTS.md': '# root',
      '.claude/skills/keep.md': 'placeholder\n',
    });
    try {
      await symlink(join('..', '..', 'nowhere'), join(repo.root, '.claude', 'skills', 'demo'));
      const snapshot = await readInitSnapshot(repo.root);
      assert.deepEqual(snapshot.skippedSymlinks ?? [], []);
    } finally {
      await repo.cleanup();
    }
  });

  it('records a symlinked COLLECTION ROOT (.claude) — include(rel) is false but include(rel + "/") catches it (gauntlet)', async () => {
    const repo = await mkTempRepo({
      'AGENTS.md': '# root',
      'shared-claude/skills/demo/SKILL.md': '---\nname: demo\ndescription: d\n---\nBody.\n',
    });
    try {
      // The whole `.claude` provider root is a symlink (dotfiles-style). The
      // walk never follows it, and the bare path `.claude` is not itself a
      // collected path — but its descendants would be, so it must be recorded.
      await symlink(join('shared-claude'), join(repo.root, '.claude'));
      const snapshot = await readInitSnapshot(repo.root);
      assert.ok(
        (snapshot.skippedSymlinks ?? []).includes('.claude'),
        'a symlinked .claude collection root must be recorded',
      );
      assert.equal(snapshot.files.some((f) => f.path.startsWith('.claude/')), false);
    } finally {
      await repo.cleanup();
    }
  });
});

// Submodule boundaries (CRITICAL): a git submodule is a SEPARATE repository
// pinned inside the parent's tree. Its `AGENTS.md` / skills are the submodule's
// own canonical config and must never be adopted into — or written under — the
// parent. The walk reads the repo-root `.gitmodules`, treats each submodule
// path as a hard boundary (does not descend, collects nothing beneath), and
// surfaces it as `skippedSubmodules` (mirroring `skippedSymlinks`).
describe('readRepoSnapshot / readInitSnapshot — submodule boundaries', () => {
  // The dogfood shape: a monorepo with a pinned submodule `references/sdlc-next`
  // that carries its OWN AGENTS.md + a skill. Before the fix the walk collected
  // them as the parent's provider files (and `apply` wrote inside the submodule).
  it('does not collect a submodule\'s AGENTS.md or skills, and records the boundary', async () => {
    const repo = await mkTempRepo({
      '.gitmodules':
        '[submodule "references/sdlc-next"]\n\tpath = references/sdlc-next\n\turl = https://example.com/sdlc-next.git\n',
      'AGENTS.md': '# parent root',
      '.agents/instructions/arch.md': '---\nscope: "src/**"\n---\nbody',
      // Everything below is INSIDE the submodule working tree — never the parent's.
      'references/sdlc-next/AGENTS.md': '# submodule canonical — not the parent\'s',
      'references/sdlc-next/.agents/skills/deploy/SKILL.md': '---\nname: deploy\ndescription: d\n---\n',
      'references/sdlc-next/src/index.ts': 'export {};',
    });
    try {
      const snapshot = await readRepoSnapshot(repo.root);
      // Only the parent's own canonical sources are collected.
      assert.deepEqual(paths(snapshot.files), ['.agents/instructions/arch.md', 'AGENTS.md']);
      // No submodule path leaked into the IR, and none was mis-reported as an
      // over-ignored canonical source (it is a boundary, not an HH-W012).
      assert.equal(
        snapshot.files.some((f) => f.path.startsWith('references/sdlc-next')),
        false,
      );
      assert.deepEqual(snapshot.excludedCanonicalPaths ?? [], []);
      // The boundary is surfaced as a note.
      assert.deepEqual(snapshot.skippedSubmodules, ['references/sdlc-next']);
    } finally {
      await repo.cleanup();
    }
  });

  it('treats the submodule as a boundary for the wider init snapshot too', async () => {
    // `init --adopt` uses readInitSnapshot (wider include: CLAUDE.md, .claude/…).
    // A submodule's provider files (CLAUDE.md, .claude/skills) must NOT be
    // adopted into the parent either — the boundary applies to both readers.
    const repo = await mkTempRepo({
      '.gitmodules': '[submodule "vendor/lib"]\n\tpath = vendor/lib\n',
      'AGENTS.md': '# parent',
      'CLAUDE.md': '@AGENTS.md\n',
      'vendor/lib/AGENTS.md': '# submodule',
      'vendor/lib/CLAUDE.md': '@AGENTS.md\n',
      'vendor/lib/.claude/skills/x/SKILL.md': '---\nname: x\ndescription: d\n---\n',
    });
    try {
      const snapshot = await readInitSnapshot(repo.root);
      assert.deepEqual(paths(snapshot.files), ['AGENTS.md', 'CLAUDE.md']);
      assert.equal(
        snapshot.files.some((f) => f.path.startsWith('vendor/lib')),
        false,
      );
      assert.deepEqual(snapshot.skippedSubmodules, ['vendor/lib']);
    } finally {
      await repo.cleanup();
    }
  });

  it('handles multiple submodules and reports them sorted+deduped', async () => {
    const repo = await mkTempRepo({
      '.gitmodules':
        '[submodule "b"]\n\tpath = sub/b\n[submodule "a"]\n\tpath = sub/a\n',
      'AGENTS.md': '# root',
      'sub/a/AGENTS.md': '# a',
      'sub/b/AGENTS.md': '# b',
    });
    try {
      const snapshot = await readRepoSnapshot(repo.root);
      assert.deepEqual(paths(snapshot.files), ['AGENTS.md']);
      assert.deepEqual(snapshot.skippedSubmodules, ['sub/a', 'sub/b']);
    } finally {
      await repo.cleanup();
    }
  });

  // REGRESSION (symlinked submodule): a submodule whose working-tree path is a
  // SYMLINK (a separate repo checked out elsewhere and linked in) used to fall
  // into the walk's symlink branch — never recorded as a skipped submodule, and
  // its target's AGENTS.md was collected as the parent's. The boundary check now
  // runs kind-agnostically BEFORE the directory/symlink branching, so the link
  // is treated as the boundary and never followed.
  it('treats a SYMLINKED submodule path as a boundary and does not follow it (repo snapshot)', async () => {
    const repo = await mkTempRepo({
      '.gitmodules': '[submodule "references/sdlc-next"]\n\tpath = references/sdlc-next\n',
      'AGENTS.md': '# parent root',
    });
    // The submodule's real checkout lives OUTSIDE the repo (a separate repo
    // linked in); its AGENTS.md must NOT be adopted via the symlink.
    const external = await mkdtemp(join(tmpdir(), 'harness-haircut-sub-'));
    await writeFile(join(external, 'AGENTS.md'), '# submodule canonical — not the parent\'s\n', 'utf8');
    try {
      await mkdir(join(repo.root, 'references'), { recursive: true });
      await symlink(external, join(repo.root, 'references', 'sdlc-next'));
      const snapshot = await readRepoSnapshot(repo.root);
      // Only the parent's own AGENTS.md is collected (the link is NOT followed).
      assert.deepEqual(paths(snapshot.files), ['AGENTS.md']);
      assert.equal(
        snapshot.files.some((f) => f.path.startsWith('references/sdlc-next')),
        false,
      );
      // The symlinked submodule is recorded as the BOUNDARY it is — not as a
      // bare skipped symlink, and not silently dropped.
      assert.deepEqual(snapshot.skippedSubmodules, ['references/sdlc-next']);
      assert.equal((snapshot.skippedSymlinks ?? []).includes('references/sdlc-next'), false);
    } finally {
      await rm(external, { recursive: true, force: true });
      await repo.cleanup();
    }
  });

  it('treats a SYMLINKED submodule path as a boundary for the wider init snapshot too', async () => {
    const repo = await mkTempRepo({
      '.gitmodules': '[submodule "vendor/lib"]\n\tpath = vendor/lib\n',
      'AGENTS.md': '# parent',
    });
    // Provider files behind the link (CLAUDE.md, .claude/skills) — outside the
    // repo — must not be adopted either; init uses the wider include filter.
    const external = await mkdtemp(join(tmpdir(), 'harness-haircut-sub-'));
    await writeFile(join(external, 'CLAUDE.md'), '@AGENTS.md\n', 'utf8');
    await mkdir(join(external, '.claude', 'skills', 'x'), { recursive: true });
    await writeFile(join(external, '.claude', 'skills', 'x', 'SKILL.md'), '---\nname: x\ndescription: d\n---\n', 'utf8');
    try {
      await mkdir(join(repo.root, 'vendor'), { recursive: true });
      await symlink(external, join(repo.root, 'vendor', 'lib'));
      const snapshot = await readInitSnapshot(repo.root);
      assert.deepEqual(paths(snapshot.files), ['AGENTS.md']);
      assert.equal(snapshot.files.some((f) => f.path.startsWith('vendor/lib')), false);
      assert.deepEqual(snapshot.skippedSubmodules, ['vendor/lib']);
      assert.equal((snapshot.skippedSymlinks ?? []).includes('vendor/lib'), false);
    } finally {
      await rm(external, { recursive: true, force: true });
      await repo.cleanup();
    }
  });

  it('a submodule directory that is not actually checked out yields no boundary note', async () => {
    // `.gitmodules` declares a submodule, but the working tree was never
    // checked out (empty/absent dir). We only record what the walk reaches on
    // disk, exactly as `skippedSymlinks` only records symlinks it encounters.
    const repo = await mkTempRepo({
      '.gitmodules': '[submodule "missing"]\n\tpath = libs/missing\n',
      'AGENTS.md': '# root',
    });
    try {
      const snapshot = await readRepoSnapshot(repo.root);
      assert.deepEqual(paths(snapshot.files), ['AGENTS.md']);
      assert.deepEqual(snapshot.skippedSubmodules ?? [], []);
    } finally {
      await repo.cleanup();
    }
  });

  // NO-REGRESSION: a repo with no .gitmodules must behave EXACTLY as before —
  // nested AGENTS.md at any depth is still collected, and the field is empty.
  it('a repo with no .gitmodules behaves exactly as before (no regression)', async () => {
    const repo = await mkTempRepo({
      'AGENTS.md': '# root',
      'references/sdlc-next/AGENTS.md': '# a plain nested dir, NOT a submodule — still collected',
      '.agents/instructions/arch.md': '---\nscope: "src/**"\n---\nbody',
    });
    try {
      const snapshot = await readRepoSnapshot(repo.root);
      assert.deepEqual(paths(snapshot.files), [
        '.agents/instructions/arch.md',
        'AGENTS.md',
        'references/sdlc-next/AGENTS.md',
      ]);
      assert.deepEqual(snapshot.skippedSubmodules ?? [], []);
    } finally {
      await repo.cleanup();
    }
  });

  it('tolerates an empty .gitmodules (no boundaries, nested AGENTS.md still collected)', async () => {
    const repo = await mkTempRepo({
      '.gitmodules': '',
      'AGENTS.md': '# root',
      'pkg/web/AGENTS.md': '# nested still collected',
    });
    try {
      const snapshot = await readRepoSnapshot(repo.root);
      assert.deepEqual(paths(snapshot.files), ['AGENTS.md', 'pkg/web/AGENTS.md']);
      assert.deepEqual(snapshot.skippedSubmodules ?? [], []);
    } finally {
      await repo.cleanup();
    }
  });

  // REGRESSION (sync/async parity on EISDIR): the writer's sync loader tolerates
  // `.gitmodules` being a DIRECTORY (ENOENT|EISDIR → no submodules); the async
  // snapshot loader caught only ENOENT, so this case made the snapshot THROW
  // while the writer silently succeeded — contradicting the loaders' "the two
  // cannot disagree" contract. The async loader now tolerates EISDIR too: no
  // boundaries, and the walk proceeds (nested AGENTS.md still collected).
  it('tolerates .gitmodules being a directory (matches the writer; no boundaries)', async () => {
    // A file UNDER `.gitmodules/` forces `.gitmodules` itself to be a directory.
    const repo = await mkTempRepo({
      '.gitmodules/keep': 'forces .gitmodules to be a directory\n',
      'AGENTS.md': '# root',
      'pkg/web/AGENTS.md': '# nested still collected',
    });
    try {
      const snapshot = await readRepoSnapshot(repo.root);
      assert.deepEqual(paths(snapshot.files), ['AGENTS.md', 'pkg/web/AGENTS.md']);
      assert.deepEqual(snapshot.skippedSubmodules ?? [], []);
      // The wider init reader shares the loader, so it must tolerate it too.
      const initSnap = await readInitSnapshot(repo.root);
      assert.deepEqual(initSnap.skippedSubmodules ?? [], []);
    } finally {
      await repo.cleanup();
    }
  });
});

describe('parseGitmodules (pure parser)', () => {
  it('captures every path under a [submodule] stanza', () => {
    const content =
      '[submodule "references/sdlc-next"]\n' +
      '\tpath = references/sdlc-next\n' +
      '\turl = https://example.com/x.git\n' +
      '[submodule "vendor/lib"]\n' +
      '\tpath = vendor/lib\n' +
      '\tbranch = main\n';
    assert.deepEqual(parseGitmodules(content), ['references/sdlc-next', 'vendor/lib']);
  });

  it('returns [] for empty / comment-only content', () => {
    assert.deepEqual(parseGitmodules(''), []);
    assert.deepEqual(parseGitmodules('# just a comment\n; another\n'), []);
  });

  it('normalizes a leading ./ and a trailing /', () => {
    const content =
      '[submodule "a"]\n\tpath = ./sub/a/\n[submodule "b"]\n\tpath = sub/b\n';
    assert.deepEqual(parseGitmodules(content), ['sub/a', 'sub/b']);
  });

  it('ignores non-path keys and blank values', () => {
    const content = '[submodule "a"]\n\turl = x\n\tpath = \n\tpath = sub/a\n';
    assert.deepEqual(parseGitmodules(content), ['sub/a']);
  });

  // Git quotes a value with special chars (e.g. a space) in DOUBLE quotes and
  // C-style-escapes the contents. The surrounding quotes are not part of the
  // path and must be stripped, or the captured value never matches the walk's
  // real `rel` path (`"my sub"` vs `my sub`) — defeating the boundary.
  it('strips surrounding double-quotes from a quoted path (space in name)', () => {
    const content = '[submodule "x"]\n\tpath = "my sub"\n';
    assert.deepEqual(parseGitmodules(content), ['my sub']);
  });

  // A backslash inside a quoted value is a C-style escape: `\"` is a literal
  // quote, `\\` a literal backslash. The old `replace(/\\/g,'/')` corrupted
  // these (turning `\"` → `/"`, `\\` → `//`); git always uses `/` as the path
  // separator anyway, so there is no backslash-as-separator to rewrite.
  it('unescapes a backslash-escaped quoted value (literal quote / backslash)', () => {
    assert.deepEqual(parseGitmodules('[submodule "x"]\n\tpath = "a\\"b"\n'), ['a"b']);
    assert.deepEqual(parseGitmodules('[submodule "y"]\n\tpath = "a\\\\b"\n'), ['a\\b']);
  });

  // An UNQUOTED value is taken verbatim — a backslash is a literal char, not a
  // separator (git would have quoted+escaped it if it were special). This is
  // the case the old separator-rewrite silently corrupted.
  it('takes an unquoted value verbatim (no backslash-to-slash rewrite)', () => {
    assert.deepEqual(parseGitmodules('[submodule "z"]\n\tpath = a\\b\n'), ['a\\b']);
  });
});

describe('isIgnored (pure matcher)', () => {
  it('negation flips an earlier exclusion (last matching pattern wins)', () => {
    assert.equal(ignored('*.md\n', 'AGENTS.md'), true);
    assert.equal(ignored('*.md\n!AGENTS.md\n', 'AGENTS.md'), false);
    // Order matters: a later re-exclusion wins over an earlier negation.
    assert.equal(ignored('*.md\n!AGENTS.md\nAGENTS.md\n', 'AGENTS.md'), true);
  });

  it('interior ** matches zero or more segments but not a fused component', () => {
    assert.equal(ignored('a/**/b\n', 'a/b'), true);
    assert.equal(ignored('a/**/b\n', 'a/x/y/b'), true);
    assert.equal(ignored('a/**/b\n', 'ab'), false);
    assert.equal(ignored('a/**/b\n', 'a/x/c'), false);
  });

  it('collapses adjacent ** segments (a/**/**/b behaves as a/**/b)', () => {
    // Consecutive globstars are semantically identical to one; before the
    // collapse they compiled to a dead regex (a literal '//') matching nothing.
    assert.equal(ignored('a/**/**/b\n', 'a/b'), true);
    assert.equal(ignored('a/**/**/b\n', 'a/x/y/b'), true);
    assert.equal(ignored('a/**/**/b\n', 'axb'), false);
  });

  it('anchored /foo matches only at the root; unanchored foo matches at any depth', () => {
    // A leading slash (or any interior slash) anchors to the repo root.
    assert.equal(ignored('/foo\n', 'foo'), true);
    assert.equal(ignored('/foo\n', 'a/foo'), false);
    // A bare basename pattern matches the basename at any depth.
    assert.equal(ignored('foo\n', 'foo'), true);
    assert.equal(ignored('foo\n', 'a/foo'), true);
  });

  it('a dir-only negation (!foo/) cannot re-include a file', () => {
    // Dir-only patterns apply only to directories, so a dir-only negation
    // leaves an earlier file exclusion in place — it never re-includes a file.
    assert.equal(ignored('*\n!foo/\n', 'foo', false), true);
    assert.equal(ignored('*\n!foo/\n', 'foo', true), false);
  });

  it('trailing /** matches everything strictly inside, never the dir basename', () => {
    assert.equal(ignored('foo/**\n', 'foo/x'), true);
    assert.equal(ignored('foo/**\n', 'foo/a/b'), true);
    assert.equal(ignored('foo/**\n', 'foobar'), false);
  });

  it('leading **/ (and the bare basename form) match at any depth', () => {
    assert.equal(ignored('**/*.bak\n', 'x.bak'), true);
    assert.equal(ignored('**/*.bak\n', 'a/b/c.bak'), true);
    assert.equal(ignored('**/*.bak\n', 'c.txt'), false);
    assert.equal(ignored('**/logs\n', 'logs', true), true);
    assert.equal(ignored('**/logs\n', 'a/b/logs', true), true);
  });

  // SECURITY (FIX 4): an attacker-controlled root .gitignore could pack a line
  // with hundreds of wildcards to trigger super-linear regex backtracking. Such
  // a line is skipped (never compiled), so it neither hangs nor takes effect,
  // while normal patterns alongside it still work.
  it('skips a pathological wildcard-heavy line without compiling or hanging', () => {
    const pathological = `${'*'.repeat(200)}\n`;
    const patterns = parseGitignore(pathological);
    assert.equal(patterns.length, 0, 'the wildcard bomb compiled to no pattern');
    // A path that the (skipped) bomb would have matched is NOT ignored.
    assert.equal(ignored(pathological, 'a/b/c/d/e.txt'), false);
    // Evaluating it must return quickly (no catastrophic backtracking).
    const start = Date.now();
    ignored(pathological, 'a'.repeat(80));
    assert.ok(Date.now() - start < 1000, 'matcher returned promptly');
  });

  it('skips an over-long .gitignore line but keeps a normal one alongside it', () => {
    const gitignore = `${'a'.repeat(2000)}\n*.bak\n`;
    const patterns = parseGitignore(gitignore);
    assert.equal(patterns.length, 1, 'only the normal pattern compiled');
    assert.equal(ignored(gitignore, 'x.bak'), true);
  });

  it('still compiles a legitimate pattern with a handful of wildcards', () => {
    // A realistic multi-wildcard pattern stays under the cap and works.
    assert.equal(ignored('build/**/*.min.*\n', 'build/a/b/x.min.js'), true);
  });

  // BLOCKER 2 (live bypass): a single segment with many intra-segment '*' runs
  // compiled to that many concatenated '[^/]*' groups — the catastrophic-
  // backtracking shape (the old measurement: 18 stars vs a 29-char path ~44s).
  // The >50 cap did NOT catch this (18 < 50). The fix collapses each '*' run to
  // a single '[^/]*', so the pattern compiles, matches correctly, and returns
  // fast — verified here against a crafted non-matching path that maximizes the
  // old backtracking.
  it('collapses an intra-segment *-run so it matches fast (no catastrophic backtracking)', () => {
    // 18 stars in ONE segment, well under the 50-wildcard cap (so NOT dropped).
    const pattern = `${'*'.repeat(18)}.zzz\n`;
    const patterns = parseGitignore(pattern);
    assert.equal(patterns.length, 1, 'the pattern compiled (not dropped by a cap)');

    // A 29-char single segment that fails the literal tail '.zzz' — the worst
    // case for adjacent unbounded quantifiers under the old compiler.
    const adversarial = 'a'.repeat(29);
    const start = Date.now();
    const verdict = ignored(pattern, adversarial);
    const elapsed = Date.now() - start;
    assert.equal(verdict, false, 'a segment without the .zzz tail is not matched');
    assert.ok(elapsed < 100, `matched in ${elapsed}ms (must be <100ms)`);

    // And a path the collapsed '*'-run SHOULD match (any within-segment run).
    assert.equal(ignored(pattern, 'anything-here.zzz'), true);
  });

  it('a collapsed *-run matches any within-segment run but never spans a separator', () => {
    // '***' collapses to one '*' → matches any run of non-'/' chars.
    assert.equal(ignored('a***b\n', 'aXYZb'), true);
    assert.equal(ignored('a***b\n', 'ab'), true);
    // A mixed multi-star segment still matches within one segment...
    assert.equal(ignored('a*b*c\n', 'aXbYc'), true);
    // ...and never spans a '/' (each '*' is [^/]*).
    assert.equal(ignored('a*b*c\n', 'aX/bYc'), false);
  });
});
