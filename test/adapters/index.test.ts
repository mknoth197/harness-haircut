import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createAdapterRegistry, createAllAdapters } from '../../dist/index.js';

describe('createAllAdapters', () => {
  it('returns all four v1 adapters without touching the default registry', () => {
    assert.deepEqual(
      createAllAdapters().map((adapter) => adapter.id),
      ['codex', 'claude', 'gemini', 'copilot'],
    );
  });

  it('returns a fresh array each call (no shared mutable state)', () => {
    assert.notEqual(createAllAdapters(), createAllAdapters());
  });

  it('wires cleanly into an isolated registry (composition-root usage)', () => {
    const registry = createAdapterRegistry(createAllAdapters());
    assert.equal(registry.listAdapters().length, 4);
    assert.equal(registry.getAdapter('copilot')?.id, 'copilot');
  });
});
