import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, defaultConfig, defaultAssistConfig, enabledProviders } from '../../dist/index.js';
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

  it('defaults exclude to an empty list and reads an explicit one (#42)', () => {
    assert.deepEqual(loadConfig(null).exclude, []);
    const config = loadConfig('{"exclude":["evals/fixtures/**","test/fixtures/**"]}');
    assert.deepEqual(config.exclude, ['evals/fixtures/**', 'test/fixtures/**']);
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
    // `null` (unset) means all four; there is no `"all"` scalar — a string is
    // never a valid `providers` value.
    assert.throws(() => loadConfig('{"providers":"all"}'), InvalidConfigError);
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

  it('throws when exclude is not an array of non-empty strings (#42)', () => {
    assert.throws(() => loadConfig('{"exclude":"evals/**"}'), InvalidConfigError);
    assert.throws(() => loadConfig('{"exclude":[123]}'), InvalidConfigError);
    assert.throws(
      () => loadConfig('{"exclude":[""]}'),
      (err: unknown) => err instanceof InvalidConfigError && /exclude/.test(err.message),
    );
  });

});

describe('loadConfig() init.assist (C4)', () => {
  it('defaults assist to disabled with safe knobs when the config is absent', () => {
    const config = loadConfig(null);
    assert.deepEqual(config.assist, defaultAssistConfig());
    assert.deepEqual(config.assist, {
      enabled: false,
      onUnavailable: 'fallback',
      endpointPolicy: 'any',
      approved: [],
      provider: null,
      model: null,
    });
  });

  it('treats the shorthand "assist": true as enabled with every other field default', () => {
    const config = loadConfig('{"init":{"assist":true}}');
    assert.equal(config.assist.enabled, true);
    assert.deepEqual(config.assist, { ...defaultAssistConfig(), enabled: true });
  });

  it('treats the shorthand "assist": false as explicitly disabled', () => {
    const config = loadConfig('{"init":{"assist":false}}');
    assert.deepEqual(config.assist, defaultAssistConfig());
  });

  it('reads every field of a full assist object', () => {
    const config = loadConfig(
      '{"init":{"assist":{"enabled":true,"onUnavailable":"fail",' +
        '"endpointPolicy":"approved-only","approved":["claude"],' +
        '"provider":"claude","model":"my-model"}}}',
    );
    assert.deepEqual(config.assist, {
      enabled: true,
      onUnavailable: 'fail',
      endpointPolicy: 'approved-only',
      approved: ['claude'],
      provider: 'claude',
      model: 'my-model',
    });
  });

  it('defaults assist when the init block omits the assist key', () => {
    const config = loadConfig('{"init":{}}');
    assert.deepEqual(config.assist, defaultAssistConfig());
  });

  it('rejects an onUnavailable value outside {fallback, fail}', () => {
    assert.throws(
      () => loadConfig('{"init":{"assist":{"onUnavailable":"retry"}}}'),
      (err: unknown) => err instanceof InvalidConfigError && err.exitCode === 3,
    );
  });

  it('rejects an endpointPolicy value outside {any, approved-only}', () => {
    assert.throws(
      () => loadConfig('{"init":{"assist":{"endpointPolicy":"none"}}}'),
      (err: unknown) => err instanceof InvalidConfigError && err.exitCode === 3,
    );
  });

  it('rejects an approved list containing an unknown provider', () => {
    assert.throws(
      () => loadConfig('{"init":{"assist":{"approved":["cursor"]}}}'),
      (err: unknown) => err instanceof InvalidConfigError && err.exitCode === 3,
    );
  });

  it('rejects a provider that is not a known id', () => {
    assert.throws(
      () => loadConfig('{"init":{"assist":{"provider":"cursor"}}}'),
      (err: unknown) => err instanceof InvalidConfigError && err.exitCode === 3,
    );
  });

  it('rejects an empty-string model', () => {
    assert.throws(
      () => loadConfig('{"init":{"assist":{"model":""}}}'),
      (err: unknown) => err instanceof InvalidConfigError && err.exitCode === 3,
    );
  });

  it('rejects a non-string model', () => {
    assert.throws(
      () => loadConfig('{"init":{"assist":{"model":123}}}'),
      (err: unknown) => err instanceof InvalidConfigError && err.exitCode === 3,
    );
  });

  it('rejects an init that is not an object', () => {
    assert.throws(
      () => loadConfig('{"init":"assist"}'),
      (err: unknown) => err instanceof InvalidConfigError && err.exitCode === 3,
    );
  });

  it('rejects an init.assist that is neither a boolean nor an object', () => {
    assert.throws(
      () => loadConfig('{"init":{"assist":42}}'),
      (err: unknown) => err instanceof InvalidConfigError && err.exitCode === 3,
    );
  });

  it('parses a config that also sets providers and gemini, defaulting assist when init is absent', () => {
    const config = loadConfig('{"providers":["claude"],"gemini":{"mode":"shim"}}');
    assert.deepEqual(config.providers, ['claude']);
    assert.equal(config.gemini.mode, 'shim');
    assert.deepEqual(config.assist, defaultAssistConfig());
  });
});
