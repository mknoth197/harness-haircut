import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readRepoSnapshot } from '../../dist/index.js';
import { isIgnored, parseGitignore } from '../../dist/gateways/filesystem.js';
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
