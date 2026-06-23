import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  loadConfig,
  defaultConfig,
  defaultAssistConfig,
  enabledProviders,
  effectiveProviders,
} from '../../dist/index.js';
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

  // #dogfood-round2 (9): `"providers": "all"` is the explicit escape hatch that
  // forces every provider on regardless of repo evidence.
  it('parses "providers": "all" as the explicit all-providers escape hatch', () => {
    const config = loadConfig('{"providers":"all"}');
    assert.equal(config.providers, 'all');
    assert.deepEqual(enabledProviders(config), ['copilot', 'claude', 'codex', 'gemini']);
  });

  it('still throws on a non-"all" providers string (only "all" is a valid scalar)', () => {
    assert.throws(() => loadConfig('{"providers":"claude"}'), InvalidConfigError);
    assert.throws(() => loadConfig('{"providers":"none"}'), InvalidConfigError);
  });
});

// #dogfood-round2 (9): effectiveProviders derives the active set from detected
// provider files when `providers` is UNSET, so apply does not materialize files
// for a provider with zero repo presence. An explicit list or `"all"` overrides
// detection. enabledProviders keeps the legacy null→all reading for callers
// without repo evidence (e.g. doctor's static echo).
describe('effectiveProviders — derive-from-detected vs explicit', () => {
  it('unset providers → only detected providers are active (in canonical order)', () => {
    const config = loadConfig(null); // providers === null
    assert.deepEqual(effectiveProviders(config, ['claude', 'codex']), ['claude', 'codex']);
    assert.deepEqual(effectiveProviders(config, ['gemini', 'copilot']), ['copilot', 'gemini']);
  });

  it('unset providers + NOTHING detected → an empty active set (no files materialized)', () => {
    assert.deepEqual(effectiveProviders(loadConfig(null), []), []);
  });

  it('"all" forces every provider on even when nothing is detected (escape hatch)', () => {
    const config = loadConfig('{"providers":"all"}');
    assert.deepEqual(effectiveProviders(config, []), ['copilot', 'claude', 'codex', 'gemini']);
  });

  it('an explicit allow-list is honored unchanged, ignoring detection', () => {
    const config = loadConfig('{"providers":["gemini"]}');
    // gemini is NOT detected, yet the explicit pin keeps it active.
    assert.deepEqual(effectiveProviders(config, ['claude', 'copilot']), ['gemini']);
  });

  it('providers_disabled is subtracted in every mode', () => {
    assert.deepEqual(
      effectiveProviders(loadConfig('{"providers_disabled":["gemini"]}'), ['gemini', 'claude']),
      ['claude'],
    );
    assert.deepEqual(
      effectiveProviders(loadConfig('{"providers":"all","providers_disabled":["codex"]}'), []),
      ['copilot', 'claude', 'gemini'],
    );
    assert.deepEqual(
      effectiveProviders(loadConfig('{"providers":["claude","gemini"],"providers_disabled":["gemini"]}'), []),
      ['claude'],
    );
  });

  it('ignores duplicate / unknown-order detected ids and dedupes via canonical order', () => {
    // Detection order does not matter; the result is canonical A-story order.
    assert.deepEqual(
      effectiveProviders(loadConfig(null), ['copilot', 'claude', 'copilot', 'codex']),
      ['copilot', 'claude', 'codex'],
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
