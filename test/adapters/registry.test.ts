import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  DuplicateAdapterError,
  createAdapterRegistry,
  getAdapter,
  listAdapters,
  registerAdapter,
} from '../../dist/index.js';
import type { Projection, ProviderAdapter, ProviderId } from '../../dist/index.js';

function fakeAdapter(id: ProviderId): ProviderAdapter {
  const projection: Projection = {
    files: [],
    warnings: [],
    surfaces: { instructions: 'skipped', skills: 'skipped', hooks: 'skipped' },
  };
  return {
    id,
    project: () => projection,
    detectExisting: () => null,
  };
}

describe('createAdapterRegistry', () => {
  it('returns registered adapters by id', () => {
    const registry = createAdapterRegistry([fakeAdapter('claude')]);
    assert.equal(registry.getAdapter('claude')?.id, 'claude');
  });

  it('returns undefined for an unregistered id', () => {
    const registry = createAdapterRegistry();
    assert.equal(registry.getAdapter('codex'), undefined);
  });

  it('throws DuplicateAdapterError when two adapters register the same id', () => {
    const registry = createAdapterRegistry([fakeAdapter('claude')]);
    assert.throws(
      () => registry.registerAdapter(fakeAdapter('claude')),
      (err: unknown) => {
        assert.equal(err instanceof DuplicateAdapterError, true);
        assert.match((err as Error).message, /"claude" is already registered/);
        return true;
      },
    );
  });

  it('throws on duplicates at initialization, before any command runs', () => {
    assert.throws(
      () => createAdapterRegistry([fakeAdapter('gemini'), fakeAdapter('gemini')]),
      DuplicateAdapterError,
    );
  });

  it('lists all registered adapters when nothing is disabled', () => {
    const registry = createAdapterRegistry([fakeAdapter('claude'), fakeAdapter('codex')]);
    assert.deepEqual(
      registry.listAdapters().map((adapter) => adapter.id),
      ['claude', 'codex'],
    );
  });

  it('excludes disabled adapters from listAdapters', () => {
    const registry = createAdapterRegistry([
      fakeAdapter('claude'),
      fakeAdapter('codex'),
      fakeAdapter('gemini'),
    ]);
    assert.deepEqual(
      registry.listAdapters(['codex']).map((adapter) => adapter.id),
      ['claude', 'gemini'],
    );
  });

  it('still returns a disabled adapter via getAdapter (disabling hides, not unregisters)', () => {
    const registry = createAdapterRegistry([fakeAdapter('claude')]);
    assert.equal(registry.listAdapters(['claude']).length, 0);
    assert.equal(registry.getAdapter('claude')?.id, 'claude');
  });
});

describe('Projection serialization', () => {
  it('per-surface summary values round-trip through JSON (for --json output)', () => {
    const projection: Projection = {
      files: [
        { path: '.claude/settings.json', body: '{}', mode: 'merge-key', mergeKey: 'hooks' },
      ],
      warnings: [{ code: 'HH-W003', severity: 'warn', message: 'unmappable', providerId: 'gemini' }],
      surfaces: { instructions: 'emitted', skills: 'native', hooks: 'merged' },
    };
    assert.deepEqual(JSON.parse(JSON.stringify(projection)), projection);
  });
});

describe('default registry module functions', () => {
  it('register, get, list, and duplicate rejection share one default registry', () => {
    registerAdapter(fakeAdapter('copilot'));
    assert.equal(getAdapter('copilot')?.id, 'copilot');
    assert.deepEqual(
      listAdapters().map((adapter) => adapter.id),
      ['copilot'],
    );
    assert.deepEqual(listAdapters(['copilot']), []);
    assert.throws(() => registerAdapter(fakeAdapter('copilot')), DuplicateAdapterError);
  });
});
