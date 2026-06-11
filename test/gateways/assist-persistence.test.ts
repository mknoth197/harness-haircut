import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import {
  assistStorePath,
  readRememberedSource,
  writeRememberedSource,
  type RememberedSource,
} from '../../dist/index.js';

// One unique scratch dir for the whole file; every store path lives under it so
// teardown is a single recursive rm and nothing touches the real home dir.
const scratch = mkdtempSync(join(tmpdir(), 'hh-assist-persist-'));
let counter = 0;
/** A fresh store path under the scratch dir; `nested` adds a not-yet-existing parent. */
function storePath(nested = false): string {
  const dir = join(scratch, `case-${counter++}`);
  return nested ? join(dir, 'deep', 'not-yet', 'assist.json') : join(dir, 'assist.json');
}

after(() => {
  rmSync(scratch, { recursive: true, force: true });
});

describe('writeRememberedSource / readRememberedSource', () => {
  it('round-trips the provider and kind it was given', () => {
    const path = storePath();
    const source: RememberedSource = { provider: 'claude', kind: 'subscription-session' };
    writeRememberedSource(path, source);
    assert.deepEqual(readRememberedSource(path), source);
  });

  it('writes a file containing exactly the provider and kind keys and nothing else', () => {
    const path = storePath();
    writeRememberedSource(path, { provider: 'copilot', kind: 'api-key' });
    const onDisk = JSON.parse(readFileSync(path, 'utf8'));
    // Structurally proves no credential value can ride along in the store.
    assert.deepEqual(Object.keys(onDisk).sort(), ['kind', 'provider']);
    assert.equal(onDisk.provider, 'copilot');
    assert.equal(onDisk.kind, 'api-key');
  });

  it('creates a missing parent directory on write', () => {
    const path = storePath(true);
    writeRememberedSource(path, { provider: 'gemini', kind: 'api-key' });
    assert.deepEqual(readRememberedSource(path), { provider: 'gemini', kind: 'api-key' });
  });
});

describe('readRememberedSource returns null for invalid stores', () => {
  it('returns null when the file is missing', () => {
    assert.equal(readRememberedSource(storePath()), null);
  });

  it('returns null when the file is malformed JSON', () => {
    const path = storePath();
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, '{ this is not json', 'utf8');
    assert.equal(readRememberedSource(path), null);
  });

  it('returns null when the JSON is an array rather than an object', () => {
    const path = storePath();
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify(['claude', 'api-key']), 'utf8');
    assert.equal(readRememberedSource(path), null);
  });

  it('returns null when the JSON is a non-object scalar', () => {
    const path = storePath();
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify('claude'), 'utf8');
    assert.equal(readRememberedSource(path), null);
  });

  it('returns null for an unknown provider value', () => {
    const path = storePath();
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify({ provider: 'mystery-llm', kind: 'api-key' }), 'utf8');
    assert.equal(readRememberedSource(path), null);
  });

  it('returns null for an unknown kind value', () => {
    const path = storePath();
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify({ provider: 'claude', kind: 'oauth-token' }), 'utf8');
    assert.equal(readRememberedSource(path), null);
  });

  it('returns null when the provider field is missing', () => {
    const path = storePath();
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify({ kind: 'api-key' }), 'utf8');
    assert.equal(readRememberedSource(path), null);
  });

  it('returns null when the kind field is missing', () => {
    const path = storePath();
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify({ provider: 'claude' }), 'utf8');
    assert.equal(readRememberedSource(path), null);
  });
});

describe('assistStorePath', () => {
  it('honors a provided XDG_CONFIG_HOME', () => {
    const xdg = join(scratch, 'xdg-home');
    const path = assistStorePath({ XDG_CONFIG_HOME: xdg } as NodeJS.ProcessEnv);
    assert.equal(path, join(xdg, 'harness-haircut', 'assist.json'));
  });

  it('falls back to a .config dir when XDG_CONFIG_HOME is unset', () => {
    const path = assistStorePath({} as NodeJS.ProcessEnv);
    assert.equal(path.endsWith(join('harness-haircut', 'assist.json')), true);
    assert.equal(path.includes(`${sep}.config${sep}`), true);
  });

  it('falls back to a .config dir when XDG_CONFIG_HOME is the empty string', () => {
    const path = assistStorePath({ XDG_CONFIG_HOME: '' } as NodeJS.ProcessEnv);
    assert.equal(path.includes(`${sep}.config${sep}`), true);
  });
});

describe('store file permissions', () => {
  it('writes the store with 0600 mode', { skip: process.platform === 'win32' }, () => {
    const path = storePath();
    writeRememberedSource(path, { provider: 'codex', kind: 'api-key' });
    assert.equal(statSync(path).mode & 0o777, 0o600);
  });
});
