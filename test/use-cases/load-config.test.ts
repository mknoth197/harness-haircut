import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, defaultConfig, enabledProviders } from '../../dist/index.js';
import { InvalidConfigError } from '../../dist/index.js';

describe('loadConfig — defaults', () => {
  it('returns all four providers enabled when the config is absent', () => {
    const config = loadConfig(null);
    assert.deepEqual(config, defaultConfig());
    assert.equal(config.providers, null);
    assert.deepEqual(config.providersDisabled, []);
    assert.equal(config.warningsAsErrors, false);
    assert.equal(config.writeGitignore, true);
    assert.equal(config.gemini.mode, 'settings');
  });

  it('enables all four providers in canonical order by default', () => {
    assert.deepEqual(enabledProviders(loadConfig(null)), ['copilot', 'claude', 'codex', 'gemini']);
  });

  it('accepts an empty JSON object as defaults', () => {
    assert.deepEqual(loadConfig('{}'), defaultConfig());
  });
});

describe('loadConfig — fields', () => {
  it('reads an explicit providers allow-list', () => {
    const config = loadConfig('{"providers":["claude","codex"]}');
    assert.deepEqual(config.providers, ['claude', 'codex']);
    assert.deepEqual(enabledProviders(config), ['claude', 'codex']);
  });

  it('subtracts providers_disabled from the enabled set', () => {
    const config = loadConfig('{"providers_disabled":["gemini","codex"]}');
    assert.deepEqual(enabledProviders(config), ['copilot', 'claude']);
  });

  it('subtracts providers_disabled from an explicit allow-list', () => {
    const config = loadConfig('{"providers":["claude","gemini"],"providers_disabled":["gemini"]}');
    assert.deepEqual(enabledProviders(config), ['claude']);
  });

  it('reads warningsAsErrors and gemini.mode', () => {
    const config = loadConfig('{"warningsAsErrors":true,"gemini":{"mode":"shim"}}');
    assert.equal(config.warningsAsErrors, true);
    assert.equal(config.gemini.mode, 'shim');
  });
});

describe('loadConfig — invalid input', () => {
  it('throws InvalidConfigError (exit 3) on malformed JSON', () => {
    assert.throws(
      () => loadConfig('{ not json'),
      (err: unknown) => err instanceof InvalidConfigError && err.exitCode === 3,
    );
  });

  it('throws when the top-level value is not an object', () => {
    assert.throws(() => loadConfig('[]'), InvalidConfigError);
    assert.throws(() => loadConfig('42'), InvalidConfigError);
  });

  it('throws on an unknown provider id', () => {
    assert.throws(
      () => loadConfig('{"providers":["cursor"]}'),
      (err: unknown) => err instanceof InvalidConfigError && /unknown provider/.test(err.message),
    );
  });

  it('throws when providers is not an array', () => {
    assert.throws(() => loadConfig('{"providers":"claude"}'), InvalidConfigError);
  });

  it('throws on a non-boolean warningsAsErrors', () => {
    assert.throws(() => loadConfig('{"warningsAsErrors":"yes"}'), InvalidConfigError);
  });

  it('throws on an invalid gemini.mode', () => {
    assert.throws(
      () => loadConfig('{"gemini":{"mode":"yaml"}}'),
      (err: unknown) => err instanceof InvalidConfigError && /gemini\.mode/.test(err.message),
    );
  });
});
