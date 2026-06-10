import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readRepoSnapshot } from '../../dist/index.js';
import { mkTempRepo } from '../_helpers/tmp-repo.ts';

function paths(files: ReadonlyArray<{ path: string }>): string[] {
  return files.map((file) => file.path);
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
});
