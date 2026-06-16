import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, existsSync } from 'node:fs';
import { mkdir, rm, symlink, writeFile, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
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

  it('doctor via spawn exits 0 and prints version + node info', () => {
    const r = spawnSync(process.execPath, [binPath, 'doctor', '--cwd', repoRoot], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /harness-haircut doctor/);
    assert.match(r.stdout, new RegExp(pkgVersion.replace(/\./g, '\\.')));
  });
});

describe('doctor E2E (spawn dist/bin.js)', () => {
  const repos: TempRepo[] = [];
  after(async () => {
    await Promise.all(repos.map((repo) => repo.cleanup()));
  });

  it('lists detected provider configs and exits 0', async () => {
    const repo = await mkTempRepo({
      'AGENTS.md': '# Project\n',
      'CLAUDE.md': '@AGENTS.md\n',
    });
    repos.push(repo);
    const r = spawnSync(process.execPath, [binPath, 'doctor', '--cwd', repo.root], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /claude/);
  });

  it('--json emits a structured report', async () => {
    const repo = await mkTempRepo({ 'AGENTS.md': '# Project\n' });
    repos.push(repo);
    const r = spawnSync(
      process.execPath,
      [binPath, 'doctor', '--cwd', repo.root, '--json'],
      { encoding: 'utf8' },
    );
    assert.equal(r.status, 0);
    const report = JSON.parse(r.stdout) as { exitCode: number; version: string };
    assert.equal(report.exitCode, 0);
    assert.equal(typeof report.version, 'string');
  });

  it('exits 3 on an invalid harness-haircut.config.json', async () => {
    const repo = await mkTempRepo({ 'AGENTS.md': '# Project\n' });
    repos.push(repo);
    await writeFile(join(repo.root, 'harness-haircut.config.json'), '{ not json', 'utf8');
    const r = spawnSync(process.execPath, [binPath, 'doctor', '--cwd', repo.root], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 3);
  });
});

describe('install-precommit E2E (spawn dist/bin.js)', () => {
  const repos: TempRepo[] = [];
  after(async () => {
    await Promise.all(repos.map((repo) => repo.cleanup()));
  });

  it('installs into .git/hooks/pre-commit and exits 0 (U1, EV2)', async () => {
    const repo = await mkTempRepo({ 'AGENTS.md': '# Project\n' });
    repos.push(repo);
    // mkTempRepo has no .git; init a real repo so `git rev-parse --git-path
    // hooks` resolves the hooks dir.
    spawnSync('git', ['init', '-q'], { cwd: repo.root, encoding: 'utf8' });
    const r = spawnSync(
      process.execPath,
      [binPath, 'install-precommit', '--cwd', repo.root],
      { encoding: 'utf8' },
    );
    assert.equal(r.status, 0);
    assert.equal(existsSync(join(repo.root, '.git', 'hooks', 'pre-commit')), true);
    const hook = readFileSync(join(repo.root, '.git', 'hooks', 'pre-commit'), 'utf8');
    assert.match(hook, /npx harness-haircut audit --json/);
    // The hook must not block on an informational lossy warning (audit exit 2).
    assert.match(hook, /if \[ "\$rc" = 2 \]; then exit 0; fi/);
  });

  it('exits 3 when run outside a git repo (UN1)', async () => {
    const repo = await mkTempRepo({ 'AGENTS.md': '# Project\n' });
    repos.push(repo);
    const r = spawnSync(
      process.execPath,
      [binPath, 'install-precommit', '--cwd', repo.root],
      { encoding: 'utf8' },
    );
    assert.equal(r.status, 3);
    assert.match(r.stderr, /not a git repository/);
  });

  it('installs in a worktree where .git is a FILE, not exit 70 (EV2)', async () => {
    // A linked worktree has a `.git` *file* (a gitlink) — the old code did
    // mkdir over <root>/.git/hooks and crashed with ENOTDIR -> exit 70.
    const main = await mkTempRepo({ 'AGENTS.md': '# Project\n' });
    repos.push(main);
    spawnSync('git', ['init', '-q'], { cwd: main.root, encoding: 'utf8' });
    // A commit is required before `git worktree add`.
    spawnSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init', '--allow-empty'], {
      cwd: main.root,
      encoding: 'utf8',
    });
    const wtPath = join(main.root, '..', `${main.root.split('/').pop()}-wt`);
    const add = spawnSync('git', ['worktree', 'add', '-q', wtPath], {
      cwd: main.root,
      encoding: 'utf8',
    });
    assert.equal(add.status, 0, add.stderr);
    repos.push({ root: wtPath, cleanup: () => rm(wtPath, { recursive: true, force: true }) });

    // Sanity: `.git` in the worktree is a file (gitlink), not a directory.
    assert.equal(readFileSync(join(wtPath, '.git'), 'utf8').startsWith('gitdir:'), true);

    const r = spawnSync(
      process.execPath,
      [binPath, 'install-precommit', '--cwd', wtPath],
      { encoding: 'utf8' },
    );
    assert.notEqual(r.status, 70);
    assert.equal(r.status, 0, r.stderr);
    // The hook was written into the worktree's resolved hooks dir.
    assert.match(r.stdout, /pre-commit/);
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

describe('init E2E (spawn dist/bin.js)', () => {
  const repos: TempRepo[] = [];
  after(async () => {
    await Promise.all(repos.map((repo) => repo.cleanup()));
  });

  it('init --non-interactive on a zero-contradiction repo exits 0, then audit exits 0', async () => {
    const body = '@AGENTS.md\n\n# Project standards\n\nUse npm test.\n';
    const repo = await mkTempRepo({ 'CLAUDE.md': body, 'GEMINI.md': body });
    repos.push(repo);
    const r = spawnSync(
      process.execPath,
      [binPath, 'init', '--cwd', repo.root, '--non-interactive'],
      { encoding: 'utf8' },
    );
    assert.equal(r.status, 0);
    assert.equal(existsSync(join(repo.root, 'AGENTS.md')), true);
    assert.equal(existsSync(join(repo.root, '.github', 'copilot-instructions.md')), true);

    const auditRun = spawnSync(process.execPath, [binPath, 'audit', '--cwd', repo.root], {
      encoding: 'utf8',
    });
    assert.equal(auditRun.status, 0);
    assert.match(auditRun.stdout, /clean/);
  });

  it('init on a tool-managed repo (state file) fast-fails (exit 1), recommends apply (C6 AD1)', async () => {
    const repo = await mkTempRepo({
      'AGENTS.md': '# Project standards\n\nUse npm test.\n',
      '.agents/.harness-state.json': '{\n  "version": 1,\n  "emitted": {}\n}\n',
      '.agents/skills/foo/SKILL.md':
        '---\nname: foo\ndescription: Use when fooing\n---\n# Foo\n\nDo it.\n',
    });
    repos.push(repo);
    const r = spawnSync(
      process.execPath,
      [binPath, 'init', '--cwd', repo.root, '--non-interactive'],
      { encoding: 'utf8' },
    );
    assert.equal(r.status, 1);
    assert.match(r.stdout, /apply/);
    assert.doesNotMatch(r.stdout, /--adopt/);
  });

  it('init on a hand-built .agents/ repo fast-fails (exit 1), recommends init --adopt (C6 AD2)', async () => {
    const repo = await mkTempRepo({
      'AGENTS.md': '# Project standards\n\nUse npm test.\n',
      '.agents/skills/foo/SKILL.md':
        '---\nname: foo\ndescription: Use when fooing\n---\n# Foo\n\nDo it.\n',
    });
    repos.push(repo);
    const r = spawnSync(
      process.execPath,
      [binPath, 'init', '--cwd', repo.root, '--non-interactive'],
      { encoding: 'utf8' },
    );
    assert.equal(r.status, 1);
    assert.match(r.stdout, /--adopt/);
  });

  it('init --adopt adopts a hand-built .agents/ repo (exit 0, C6 AD3)', async () => {
    const repo = await mkTempRepo({
      'AGENTS.md': '# Project standards\n\nUse npm test.\n',
      '.agents/skills/foo/SKILL.md':
        '---\nname: foo\ndescription: Use when fooing\n---\n# Foo\n\nDo it.\n',
    });
    repos.push(repo);
    const r = spawnSync(
      process.execPath,
      [binPath, 'init', '--cwd', repo.root, '--adopt', '--non-interactive'],
      { encoding: 'utf8' },
    );
    assert.equal(r.status, 0);
    assert.match(r.stdout, /projected/);
  });

  it('init --non-interactive exits 1 on a contradiction', async () => {
    const repo = await mkTempRepo({
      'CLAUDE.md': '@AGENTS.md\n\n# A\nUse npm test.\n',
      '.github/copilot-instructions.md': '# A\nUse pnpm test.\n',
    });
    repos.push(repo);
    const r = spawnSync(
      process.execPath,
      [binPath, 'init', '--cwd', repo.root, '--non-interactive'],
      { encoding: 'utf8' },
    );
    assert.equal(r.status, 1);
    assert.match(r.stdout, /contradiction/i);
  });
});

/**
 * C4 (#28) `init --assist` composition-root behavior, E2E against the built
 * `dist/bin.js` (testing.md category 3). OFFLINE by construction: no test here
 * lets discovery find a real source, so no provider SDK is loaded and no
 * provider CLI is spawned (PRD §17). No real credential is ever written to a
 * fixture — the scrubbed-env cases below DELETE every credential env var and
 * point HOME at a fresh empty dir so `discoverCredentialSources` returns nothing.
 *
 * Covers: OPT2 fail-closed via the flag (a) and via config (b); OPT1 no-source
 * `fail` (c) and default `fallback` (d) under a scrubbed environment; and the
 * C4-review shared-interface regression for piped contradiction prompts (e).
 */
describe('init --assist (C4 CLI)', () => {
  const repos: TempRepo[] = [];
  const scrubHomes: string[] = [];
  after(async () => {
    await Promise.all([
      ...repos.map((repo) => repo.cleanup()),
      ...scrubHomes.map((home) => rm(home, { recursive: true, force: true })),
    ]);
  });

  /** A repo with two DIFFERENT root instruction files → one real contradiction. */
  async function contradictingRepo(): Promise<TempRepo> {
    const repo = await mkTempRepo({
      'CLAUDE.md': '@AGENTS.md\n\n# Project\nUse npm test.\n',
      '.github/copilot-instructions.md': '# Project\nUse pnpm test.\n',
    });
    repos.push(repo);
    return repo;
  }

  /**
   * A spawn environment in which credential discovery finds NOTHING, so an
   * `--assist` run cannot reach a real provider on this (or any) machine:
   *   - PATH is ONLY the directory holding the node binary, so the four provider
   *     CLIs (claude/codex/gemini/copilot) are not resolvable. A
   *     subscription-session source requires the binary on PATH, so none can be
   *     offered (the macOS-Keychain probe is gated behind that binary check and
   *     never runs).
   *   - HOME / USERPROFILE / XDG_CONFIG_HOME point at a fresh empty dir, so the
   *     file-presence session markers (~/.claude/.credentials.json,
   *     ~/.codex/auth.json, ~/.gemini/oauth_creds.json, ~/.copilot/config.json)
   *     are absent. os.homedir() honors HOME on this platform, including in the
   *     spawned child, so the probes look in the empty dir.
   *   - Every API-key env var is deleted, so no api-key source is offered.
   */
  async function scrubbedEnv(): Promise<NodeJS.ProcessEnv> {
    const emptyHome = await mkdtemp(join(tmpdir(), 'hh-assist-scrub-home-'));
    scrubHomes.push(emptyHome);
    const env: NodeJS.ProcessEnv = { ...process.env };
    for (const key of [
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'GEMINI_API_KEY',
      'GOOGLE_API_KEY',
      'CLAUDE_CODE_OAUTH_TOKEN',
      'COPILOT_GITHUB_TOKEN',
      'GH_TOKEN',
      'GITHUB_TOKEN',
    ]) {
      delete env[key];
    }
    env['PATH'] = dirname(process.execPath);
    env['HOME'] = emptyHome;
    env['USERPROFILE'] = emptyHome;
    env['XDG_CONFIG_HOME'] = emptyHome;
    return env;
  }

  it('(a) OPT2: --assist --non-interactive fails closed (exit 1) and writes nothing', async () => {
    const repo = await contradictingRepo();
    const r = spawnSync(
      process.execPath,
      [binPath, 'init', '--assist', '--non-interactive', '--cwd', repo.root],
      { encoding: 'utf8', input: '' },
    );
    // OPT2: credential selection + merge approval both need prompts, so the
    // combination fails before doing any work.
    assert.equal(r.status, 1);
    assert.match(r.stderr, /cannot be combined with --non-interactive/);
    // It failed closed: no canonical AGENTS.md was written.
    assert.equal(existsSync(join(repo.root, 'AGENTS.md')), false);
  });

  it('(b) OPT2: config-enabled assist + --non-interactive also fails closed (exit 1)', async () => {
    const repo = await contradictingRepo();
    // Enable assist through team-shared config rather than the flag; the
    // --non-interactive combination must STILL fail closed.
    await writeFile(
      join(repo.root, 'harness-haircut.config.json'),
      `${JSON.stringify({ init: { assist: true } })}\n`,
      'utf8',
    );
    const r = spawnSync(
      process.execPath,
      [binPath, 'init', '--non-interactive', '--cwd', repo.root],
      { encoding: 'utf8', input: '' },
    );
    assert.equal(r.status, 1);
    assert.match(r.stderr, /cannot be combined with --non-interactive/);
    assert.equal(existsSync(join(repo.root, 'AGENTS.md')), false);
  });

  it('(c) OPT1 fail: no discovered source + onUnavailable:"fail" exits 3 with an actionable message', async () => {
    const repo = await contradictingRepo();
    await writeFile(
      join(repo.root, 'harness-haircut.config.json'),
      `${JSON.stringify({ init: { assist: { enabled: true, onUnavailable: 'fail' } } })}\n`,
      'utf8',
    );
    const env = await scrubbedEnv();
    const r = spawnSync(process.execPath, [binPath, 'init', '--assist', '--cwd', repo.root], {
      encoding: 'utf8',
      input: '', // EOF on stdin — the run must fail before any prompt.
      env,
    });
    assert.equal(r.status, 3);
    // UN2/OPT1: names the absent credential and what to install / set.
    assert.match(r.stderr, /no usable AI credential source/i);
    assert.match(r.stderr, /API key|log in to a provider CLI|env var|install/i);
    // The scrub worked: discovery found nothing, so the source-selection menu
    // was never printed (it would only appear if a real source leaked in).
    assert.doesNotMatch(r.stdout, /credential sources discovered/i);
  });

  it('(d) OPT1 fallback (default): no source falls back to the deterministic resolver and proceeds (exit 0)', async () => {
    const repo = await contradictingRepo();
    // onUnavailable defaults to "fallback" when only `enabled` is set.
    await writeFile(
      join(repo.root, 'harness-haircut.config.json'),
      `${JSON.stringify({ init: { assist: { enabled: true } } })}\n`,
      'utf8',
    );
    const env = await scrubbedEnv();
    const r = spawnSync(process.execPath, [binPath, 'init', '--cwd', repo.root], {
      encoding: 'utf8',
      input: '1\n', // deterministic choice for the surviving contradiction.
      env,
    });
    assert.equal(r.status, 0);
    // The fallback warning names the missing source AND that the deterministic
    // resolver is being used.
    assert.match(r.stderr, /no AI (credential )?source/i);
    assert.match(r.stderr, /deterministic/i);
    // The run proceeded deterministically: canonical AGENTS.md was written.
    assert.equal(existsSync(join(repo.root, 'AGENTS.md')), true);
  });

  /**
   * (e) SHARED-INTERFACE regression (C4-review): the several sequential `init`
   * prompts run over a SINGLE shared prompt created lazily on the first use
   * (cli.ts `createStdinPrompt`). The old code opened and CLOSED a fresh
   * readline interface per prompt, which discarded readline's buffered
   * read-ahead and dropped piped input after the first prompt. This pipes a
   * contradiction answer (`1\n`) and asserts it resolves end-to-end.
   *
   * The historical two-contradiction caveat (EOF closing readline between
   * prompts discarded the buffered second answer) was #39 and is fixed by the
   * line-buffered prompt; the `'1\n1\n'` form is exercised in the
   * "prompt lifecycle E2E (#39)" suite below.
   */
  it('(e) resolves a piped contradiction answer over the shared readline interface (exit 0)', async () => {
    // Two DIFFERENT root files → one `root-instructions` contradiction.
    // Candidates are provider-sorted (claude < copilot), so choice 1 is the
    // CLAUDE.md candidate (its recovered body uses `npm test`).
    const repo = await mkTempRepo({
      'CLAUDE.md': '@AGENTS.md\n\n# Project\nUse npm test.\n',
      '.github/copilot-instructions.md': '# Project\nUse pnpm test.\n',
    });
    repos.push(repo);
    const r = spawnSync(process.execPath, [binPath, 'init', '--cwd', repo.root], {
      encoding: 'utf8',
      input: '1\n', // pick candidate 1 over the shared interface.
    });
    assert.equal(r.status, 0);
    const agents = readFileSync(join(repo.root, 'AGENTS.md'), 'utf8');
    // Candidate 1 (claude/npm) became canonical; candidate 2 (copilot/pnpm) did not.
    assert.match(agents, /Use npm test\./);
    assert.doesNotMatch(agents, /Use pnpm test\./);
    // The piped answer was consumed and the run projected cleanly end-to-end.
    const auditRun = spawnSync(process.execPath, [binPath, 'audit', '--cwd', repo.root], {
      encoding: 'utf8',
    });
    assert.equal(auditRun.status, 0);
    assert.match(auditRun.stdout, /clean/);
  });
});

/**
 * #39 — prompt lifecycle. Two confirmed failure modes of the old prompt:
 * (a) EOF while a prompt awaited: rl.question never called back, the promise
 *     dangled, the event loop drained, and Node exited 0 mid-await with the
 *     ENTIRE report dropped — success, to a script, for an aborted run.
 * (b) EOF between prompts (piped multi-answer input): readline closed and
 *     discarded its buffer; the next question threw ERR_USE_AFTER_CLOSE,
 *     surfaced as `harness-haircut: readline was closed`, exit 70.
 * The line-buffered shared prompt resolves EOF'd prompts with '' (mapped to
 * each caller's safe default) and queues lines until a prompt consumes them.
 */
describe('prompt lifecycle E2E (#39, spawn dist/bin.js)', () => {
  const repos: TempRepo[] = [];
  after(async () => {
    await Promise.all(repos.map((repo) => repo.cleanup()));
  });

  /** Two differing root files → one `root-instructions` contradiction. */
  async function contradictionRepo(): Promise<TempRepo> {
    const repo = await mkTempRepo({
      'CLAUDE.md': '@AGENTS.md\n\n# Project\nUse npm test.\n',
      '.github/copilot-instructions.md': '# Project\nUse pnpm test.\n',
    });
    repos.push(repo);
    return repo;
  }

  it('(a) EOF during a prompt exits 1 WITH the refusal report (was: silent exit 0)', async () => {
    const repo = await contradictionRepo();
    const r = spawnSync(process.execPath, [binPath, 'init', '--cwd', repo.root], {
      encoding: 'utf8',
      input: '', // stdin exhausted before the contradiction prompt.
    });
    // The documented EOF → unresolved → exit-1 path is now reachable.
    assert.equal(r.status, 1);
    assert.match(r.stdout, /refused — 1 unresolved contradiction/);
    // Nothing was written for the aborted onboarding.
    assert.equal(existsSync(join(repo.root, 'AGENTS.md')), false);
  });

  it('(b) piped multi-answer input survives the gap between prompts (two contradictions)', async () => {
    // root-instructions (differing root files) + skill:foo (same skill under
    // two provider roots with differing bodies) → exactly two prompts.
    const repo = await mkTempRepo({
      'CLAUDE.md': '@AGENTS.md\n\n# Project\nUse npm test.\n',
      '.github/copilot-instructions.md': '# Project\nUse pnpm test.\n',
      '.claude/skills/foo/SKILL.md':
        '---\nname: foo\ndescription: Use when fooing\n---\n# Foo\n\nClaude variant.\n',
      '.codex/skills/foo/SKILL.md':
        '---\nname: foo\ndescription: Use when fooing\n---\n# Foo\n\nCodex variant.\n',
    });
    repos.push(repo);
    const r = spawnSync(process.execPath, [binPath, 'init', '--cwd', repo.root], {
      encoding: 'utf8',
      input: '1\n1\n', // both answers arrive in one buffer; EOF follows immediately.
    });
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stderr, /readline was closed/);
    assert.match(r.stdout, /resolved 2 contradiction\(s\)/);
    // BOTH resolutions landed: canonical root + canonical skill exist.
    assert.match(readFileSync(join(repo.root, 'AGENTS.md'), 'utf8'), /Use npm test\./);
    assert.match(
      readFileSync(join(repo.root, '.agents', 'skills', 'foo', 'SKILL.md'), 'utf8'),
      /Claude variant\./,
    );
  });

  it('(a+b) apply: EOF mid-confirmations blocks the unanswered file and still prints the report', async () => {
    const repo = await mkTempRepo({
      'AGENTS.md': '# Project standards\n\nUse npm test.\n',
      '.agents/skills/foo/SKILL.md':
        '---\nname: foo\ndescription: Use when fooing\n---\n# Foo\n\nDo it.\n',
    });
    repos.push(repo);
    // Emit, then hand-edit TWO generated header-bearing files → two prompts.
    spawnSync(process.execPath, [binPath, 'apply', '--cwd', repo.root, '--allow-dirty'], {
      encoding: 'utf8',
    });
    for (const rel of ['.claude/skills/foo/SKILL.md', '.github/copilot-instructions.md']) {
      const abs = join(repo.root, ...rel.split('/'));
      await writeFile(abs, `${readFileSync(abs, 'utf8')}\nHAND EDIT\n`, 'utf8');
    }
    const r = spawnSync(
      process.execPath,
      [binPath, 'apply', '--cwd', repo.root, '--allow-dirty'],
      { encoding: 'utf8', input: 'y\n' }, // one answer, then EOF before prompt 2.
    );
    // Old (a): fresh-interface-per-question dangled on the exhausted stdin and
    // Node exited 0 BEFORE planning finished — no writes, no report. Now: the
    // confirmed file is overwritten, the EOF'd one declines (blocked), and the
    // full report prints.
    assert.equal(r.status, 0);
    assert.doesNotMatch(r.stderr, /readline was closed/);
    assert.match(r.stdout, /wrote 1 file\(s\)/);
    assert.match(r.stdout, /blocked 1 edited file\(s\)/);
  });
});

/**
 * #35 — symlink-aliased provider targets (the cerebro shape):
 * `.claude/skills/<name>` is a hand-made symlink into `.agents/skills/<name>`.
 * The old writer followed the in-repo symlinked parent and clobbered the
 * canonical SKILL.md (dropping `allowed-tools:`), and the next audit reported
 * drift:stale — apply→audit broke its own idempotency contract.
 */
describe('symlink-aliased targets E2E (#35, spawn dist/bin.js)', () => {
  const repos: TempRepo[] = [];
  after(async () => {
    await Promise.all(repos.map((repo) => repo.cleanup()));
  });

  const CANONICAL_SKILL =
    '---\nname: foo\ndescription: Use when fooing\nallowed-tools: "Read"\n---\n# Foo\n\nDo it.\n';

  async function aliasedRepo(): Promise<TempRepo> {
    const repo = await mkTempRepo({
      'AGENTS.md': '# Project standards\n\nUse npm test.\n',
      '.agents/skills/foo/SKILL.md': CANONICAL_SKILL,
    });
    repos.push(repo);
    await mkdir(join(repo.root, '.claude', 'skills'), { recursive: true });
    await symlink(
      join('..', '..', '.agents', 'skills', 'foo'),
      join(repo.root, '.claude', 'skills', 'foo'),
    );
    return repo;
  }

  it('apply skips the aliased path with HH-W013 and leaves the canonical source byte-identical', async () => {
    const repo = await aliasedRepo();
    const r = spawnSync(
      process.execPath,
      [binPath, 'apply', '--cwd', repo.root, '--allow-dirty'],
      { encoding: 'utf8' },
    );
    assert.equal(r.status, 0);
    assert.match(r.stdout, /symlink-aliased path\(s\) \(HH-W013/);
    assert.match(r.stdout, /aliased\t\.claude\/skills\/foo\/SKILL\.md/);
    // The canonical source was NOT written through the symlink: keys intact,
    // no @generated header injected.
    assert.equal(
      readFileSync(join(repo.root, '.agents', 'skills', 'foo', 'SKILL.md'), 'utf8'),
      CANONICAL_SKILL,
    );
  });

  it('audit after apply reports aliased (exit 2), not drift:stale (exit 1)', async () => {
    const repo = await aliasedRepo();
    spawnSync(process.execPath, [binPath, 'apply', '--cwd', repo.root, '--allow-dirty'], {
      encoding: 'utf8',
    });
    const r = spawnSync(process.execPath, [binPath, 'audit', '--cwd', repo.root], {
      encoding: 'utf8',
    });
    assert.equal(r.status, 2);
    assert.doesNotMatch(r.stdout, /stale/);
    assert.match(r.stdout, /skipped 1 symlink-aliased path\(s\) \(HH-W013, not audited\)/);
    assert.match(r.stdout, /HH-W013/);
  });

  // Review M1: `.agents` itself as a symlink must refuse init up front (the
  // old behavior crashed exit 70 mid-onboarding on the first canonical write).
  it('init refuses a symlinked .agents before any write (exit 1, no backups)', async () => {
    const repo = await mkTempRepo({
      'CLAUDE.md': '@AGENTS.md\n\n# Project\nUse npm test.\n',
      'cfg-agents/.keep': '',
    });
    repos.push(repo);
    await symlink('cfg-agents', join(repo.root, '.agents'));
    const r = spawnSync(process.execPath, [binPath, 'init', '--cwd', repo.root], {
      encoding: 'utf8',
      input: '',
    });
    assert.equal(r.status, 1);
    assert.match(r.stdout, /refused — \.agents is a symlink/);
    assert.equal(existsSync(join(repo.root, 'AGENTS.md')), false);
    assert.equal(existsSync(join(repo.root, '.harness-haircut-init-backup')), false);
  });
});
