import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { rm, writeFile } from 'node:fs/promises';
import { parseArgs, run } from '../dist/index.js';
import { mkTempRepo } from './_helpers/tmp-repo.ts';
import type { TempRepo } from './_helpers/tmp-repo.ts';
import { emitProjection } from './_helpers/emit.ts';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const binPath = resolve(repoRoot, 'dist', 'bin.js');
const pkgVersion = (
  JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as { version: string }
).version;

class StringStream {
  data = '';
  write(chunk: string | Uint8Array): boolean {
    this.data += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }
}

async function runCli(argv: readonly string[]) {
  const stdout = new StringStream();
  const stderr = new StringStream();
  const code = await run(argv, {
    stdout: stdout as unknown as NodeJS.WritableStream,
    stderr: stderr as unknown as NodeJS.WritableStream,
  });
  return { code, stdout: stdout.data, stderr: stderr.data };
}

describe('parseArgs', () => {
  it('parses a bare command', () => {
    const r = parseArgs(['audit']);
    assert.equal(r.command, 'audit');
    assert.deepEqual(r.flags, {});
    assert.deepEqual(r.positional, []);
  });

  it('parses boolean flags before a command', () => {
    const r = parseArgs(['--verbose', 'audit']);
    assert.equal(r.command, 'audit');
    assert.equal(r.flags['--verbose'], true);
  });

  it('parses --cwd with value', () => {
    const r = parseArgs(['--cwd', '/tmp/foo', 'audit']);
    assert.equal(r.flags['--cwd'], '/tmp/foo');
    assert.equal(r.command, 'audit');
  });

  it('parses --flag=value', () => {
    const r = parseArgs(['--config=./foo.json', 'audit']);
    assert.equal(r.flags['--config'], './foo.json');
  });

  it('rejects --cwd with no value (last token)', () => {
    const r = parseArgs(['--cwd']);
    assert.match(r.error ?? '', /missing value for --cwd/);
  });

  it('rejects --cwd when followed by another flag instead of a value', () => {
    const r = parseArgs(['--cwd', '--verbose', 'audit']);
    assert.match(r.error ?? '', /missing value for --cwd/);
  });

  it('rejects --config with no value', () => {
    const r = parseArgs(['--config']);
    assert.match(r.error ?? '', /missing value for --config/);
  });
});

describe('run() in-process', () => {
  it('--version prints the package version and exits 0', async () => {
    const { code, stdout } = await runCli(['--version']);
    assert.equal(code, 0);
    assert.equal(stdout.trim(), pkgVersion);
  });

  it('--help prints usage and exits 0', async () => {
    const { code, stdout } = await runCli(['--help']);
    assert.equal(code, 0);
    assert.match(stdout, /Usage:/);
    assert.match(stdout, /Commands:/);
  });

  it('no args prints help and exits 0', async () => {
    const { code, stdout } = await runCli([]);
    assert.equal(code, 0);
    assert.match(stdout, /Usage:/);
  });

  it('unknown command exits 64', async () => {
    const { code, stderr } = await runCli(['frobnicate']);
    assert.equal(code, 64);
    assert.match(stderr, /unknown command/);
  });

  it('unimplemented commands (init/doctor) exit 70', async () => {
    for (const command of ['init', 'doctor']) {
      const { code, stderr } = await runCli([command]);
      assert.equal(code, 70);
      assert.match(stderr, /not yet implemented/);
    }
  });

  it('parser error (--cwd with no value) exits 64', async () => {
    const { code, stderr } = await runCli(['--cwd']);
    assert.equal(code, 64);
    assert.match(stderr, /missing value for --cwd/);
  });
});

describe('built CLI binary', () => {
  it('--version via spawn matches package.json', () => {
    const r = spawnSync(process.execPath, [binPath, '--version'], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), pkgVersion);
  });

  it('init via spawn exits 70 (still a stub)', () => {
    const r = spawnSync(process.execPath, [binPath, 'init'], { encoding: 'utf8' });
    assert.equal(r.status, 70);
    assert.match(r.stderr, /not yet implemented/);
  });
});

describe('audit E2E (spawn dist/bin.js)', () => {
  const repos: TempRepo[] = [];
  after(async () => {
    await Promise.all(repos.map((repo) => repo.cleanup()));
  });

  async function cleanRepo(): Promise<TempRepo> {
    const repo = await mkTempRepo({
      'AGENTS.md': '# Project standards\n\nUse npm test.\n',
      '.agents/skills/foo/SKILL.md':
        '---\nname: foo\ndescription: Use when fooing\n---\n# Foo\n\nDo it.\n',
    });
    repos.push(repo);
    await emitProjection(repo.root);
    return repo;
  }

  it('exits 0 on a clean canonical repo', async () => {
    const repo = await cleanRepo();
    const r = spawnSync(process.execPath, [binPath, 'audit', '--cwd', repo.root], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /clean/);
  });

  it('exits 1 on a drifted repo', async () => {
    const repo = await cleanRepo();
    await rm(join(repo.root, '.github', 'copilot-instructions.md'));
    const r = spawnSync(process.execPath, [binPath, 'audit', '--cwd', repo.root], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /drift/);
  });

  it('--json emits a structured report', async () => {
    const repo = await cleanRepo();
    const r = spawnSync(
      process.execPath,
      [binPath, 'audit', '--cwd', repo.root, '--json'],
      { encoding: 'utf8' },
    );
    assert.equal(r.status, 0);
    const report = JSON.parse(r.stdout) as { exitCode: number; files: unknown[] };
    assert.equal(report.exitCode, 0);
    assert.ok(Array.isArray(report.files));
  });

  it('exits 3 on a malformed harness-haircut.config.json', async () => {
    const repo = await cleanRepo();
    await writeFile(join(repo.root, 'harness-haircut.config.json'), '{ not json', 'utf8');
    const r = spawnSync(process.execPath, [binPath, 'audit', '--cwd', repo.root], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /harness-haircut/);
  });

  it('exits 3 on a malformed canonical source, naming the file (UN1)', async () => {
    const repo = await mkTempRepo({
      'AGENTS.md': '# Project\n',
      '.agents/instructions/broken.md': '# missing scope frontmatter\n',
    });
    repos.push(repo);
    const r = spawnSync(process.execPath, [binPath, 'audit', '--cwd', repo.root], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /broken\.md/);
  });

  /**
   * A repo whose projection fires a lossy warning (HH-W007: scoped fragment
   * unrepresentable for Gemini) while disk matches every emitted file.
   */
  async function lossyRepo(): Promise<TempRepo> {
    const repo = await mkTempRepo({
      'AGENTS.md': '# Project\n\nUse npm test.\n',
      '.agents/instructions/testing.md':
        '---\nscope: "test/**/*.ts"\n---\n# Testing\n\nUse node:test.\n',
    });
    repos.push(repo);
    await emitProjection(repo.root);
    return repo;
  }

  it('exits 2 when only lossy warnings fire (EV4)', async () => {
    const repo = await lossyRepo();
    const r = spawnSync(process.execPath, [binPath, 'audit', '--cwd', repo.root], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 2);
    assert.match(r.stdout, /HH-W007/);
  });

  it('--strict escalates lossy warnings to exit 1 (OPT1)', async () => {
    const repo = await lossyRepo();
    const r = spawnSync(
      process.execPath,
      [binPath, 'audit', '--cwd', repo.root, '--strict'],
      { encoding: 'utf8' },
    );
    assert.equal(r.status, 1);
  });

  it('config warningsAsErrors escalates lossy warnings to exit 1', async () => {
    const repo = await lossyRepo();
    await writeFile(
      join(repo.root, 'harness-haircut.config.json'),
      '{ "warningsAsErrors": true }\n',
      'utf8',
    );
    const r = spawnSync(process.execPath, [binPath, 'audit', '--cwd', repo.root], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 1);
  });
});

describe('apply E2E (spawn dist/bin.js)', () => {
  const repos: TempRepo[] = [];
  after(async () => {
    await Promise.all(repos.map((repo) => repo.cleanup()));
  });

  async function canonicalRepo(): Promise<TempRepo> {
    const repo = await mkTempRepo({
      'AGENTS.md': '# Project standards\n\nUse npm test.\n',
      '.agents/skills/foo/SKILL.md':
        '---\nname: foo\ndescription: Use when fooing\n---\n# Foo\n\nDo it.\n',
      '.agents/hooks/pre-tool-use.lint.sh': '#!/usr/bin/env bash\necho lint\n',
    });
    repos.push(repo);
    return repo;
  }

  it('apply --allow-dirty writes provider files to disk and exits 0', async () => {
    const repo = await canonicalRepo();
    const r = spawnSync(
      process.execPath,
      [binPath, 'apply', '--cwd', repo.root, '--allow-dirty'],
      { encoding: 'utf8' },
    );
    assert.equal(r.status, 0);
    assert.match(r.stdout, /wrote/);
    // The projected files appear on disk.
    assert.equal(existsSync(join(repo.root, '.github', 'copilot-instructions.md')), true);
    assert.equal(existsSync(join(repo.root, '.claude', 'settings.json')), true);
    assert.equal(existsSync(join(repo.root, '.codex', 'hooks.json')), true);
    assert.equal(existsSync(join(repo.root, '.agents', '.harness-state.json')), true);
  });

  it('a second apply prints "nothing to do" and exits 0 (idempotent)', async () => {
    const repo = await canonicalRepo();
    spawnSync(process.execPath, [binPath, 'apply', '--cwd', repo.root, '--allow-dirty'], {
      encoding: 'utf8',
    });
    const r = spawnSync(
      process.execPath,
      [binPath, 'apply', '--cwd', repo.root, '--allow-dirty'],
      { encoding: 'utf8' },
    );
    assert.equal(r.status, 0);
    assert.match(r.stdout, /nothing to do/);
  });

  it('audit after apply exits 0 (idempotency end-to-end)', async () => {
    const repo = await canonicalRepo();
    spawnSync(process.execPath, [binPath, 'apply', '--cwd', repo.root, '--allow-dirty'], {
      encoding: 'utf8',
    });
    const r = spawnSync(process.execPath, [binPath, 'audit', '--cwd', repo.root], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /clean/);
  });

  it('refuses on a dirty (non-git) tree without --allow-dirty, exit 1', async () => {
    const repo = await canonicalRepo();
    const r = spawnSync(process.execPath, [binPath, 'apply', '--cwd', repo.root], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /refused/);
  });

  it('--dry-run writes nothing and exits 0', async () => {
    const repo = await canonicalRepo();
    const r = spawnSync(
      process.execPath,
      [binPath, 'apply', '--cwd', repo.root, '--allow-dirty', '--dry-run'],
      { encoding: 'utf8' },
    );
    assert.equal(r.status, 0);
    assert.match(r.stdout, /dry run/);
    assert.equal(existsSync(join(repo.root, '.github', 'copilot-instructions.md')), false);
  });
});
