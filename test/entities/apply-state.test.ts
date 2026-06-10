/**
 * Apply-state entity — UNIT tests (testing.md category 1, pure, no I/O).
 * Pins the headerless three-way classifier and the state-file format that the
 * C2 design note specifies.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyHeaderless,
  contentHash,
  emptyState,
  parseState,
  serializeState,
  APPLY_STATE_PATH,
} from '../../dist/index.js';

describe('classifyHeaderless()', () => {
  it('clean when disk equals the current projection (EOL-insensitive)', () => {
    assert.equal(classifyHeaderless('a\nb\n', 'a\r\nb\n', contentHash('x')), 'clean');
  });

  it('stale when disk differs from projection but equals the recorded prior emission', () => {
    const disk = '{"old":true}\n';
    assert.equal(classifyHeaderless(disk, '{"new":true}\n', contentHash(disk)), 'stale');
  });

  it('edited when disk differs from both projection and the recorded emission', () => {
    assert.equal(
      classifyHeaderless('{"user":1}\n', '{"new":true}\n', contentHash('{"old":true}\n')),
      'edited',
    );
  });

  it('edited (conservative) when there is no recorded prior emission and disk differs', () => {
    assert.equal(classifyHeaderless('{"user":1}\n', '{"new":true}\n', undefined), 'edited');
  });
});

describe('apply-state format', () => {
  it('parse(null) and a corrupt file both degrade to an empty state', () => {
    assert.deepEqual(parseState(null), emptyState());
    assert.deepEqual(parseState('{ not json'), emptyState());
    assert.deepEqual(parseState('[]'), emptyState());
    assert.deepEqual(parseState('{"emitted":[]}'), emptyState());
  });

  it('round-trips emitted entries and sorts keys deterministically', () => {
    const text = serializeState({
      version: 1,
      emitted: { 'b.json': 'h2', 'a.json': 'h1' },
    });
    assert.ok(text.endsWith('\n'));
    const back = parseState(text);
    assert.deepEqual(back.emitted, { 'a.json': 'h1', 'b.json': 'h2' });
    // Sorted: a before b in the serialized text.
    assert.ok(text.indexOf('a.json') < text.indexOf('b.json'));
  });

  it('drops non-string emitted values defensively', () => {
    const back = parseState('{"version":1,"emitted":{"ok":"h","bad":42}}');
    assert.deepEqual(back.emitted, { ok: 'h' });
  });

  it('exposes the canonical state path under .agents/', () => {
    assert.equal(APPLY_STATE_PATH, '.agents/.harness-state.json');
  });
});
