import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { parseArgs, run } from '../dist/index.js';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const cliPath = resolve(repoRoot, 'dist', 'cli.js');
const pkgVersion = JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')).version;

class StringStream {
  constructor() {
    this.data = '';
  }
  write(chunk) {
    this.data += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  }
}

async function runCli(argv) {
  const stdout = new StringStream();
  const stderr = new StringStream();
  const code = await run(argv, { stdout, stderr });
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

  it('known but unimplemented command exits 70', async () => {
    const { code, stderr } = await runCli(['audit']);
    assert.equal(code, 70);
    assert.match(stderr, /not yet implemented/);
  });
});

describe('built CLI binary', () => {
  it('--version via spawn matches package.json', () => {
    const r = spawnSync(process.execPath, [cliPath, '--version'], { encoding: 'utf8' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), pkgVersion);
  });

  it('audit via spawn exits 70', () => {
    const r = spawnSync(process.execPath, [cliPath, 'audit'], { encoding: 'utf8' });
    assert.equal(r.status, 70);
    assert.match(r.stderr, /not yet implemented/);
  });
});
