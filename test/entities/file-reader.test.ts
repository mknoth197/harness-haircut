import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFileReader } from '../../dist/index.js';

describe('createFileReader', () => {
  it('reads contents for known paths and reports existence', () => {
    const reader = createFileReader({ 'CLAUDE.md': '@AGENTS.md\n' });
    assert.equal(reader.read('CLAUDE.md'), '@AGENTS.md\n');
    assert.equal(reader.exists('CLAUDE.md'), true);
  });

  it('returns null and false for unknown paths', () => {
    const reader = createFileReader({});
    assert.equal(reader.read('.codex/config.toml'), null);
    assert.equal(reader.exists('.codex/config.toml'), false);
  });

  it('treats an empty file as existing with empty content, not as absent', () => {
    const reader = createFileReader({ '.gemini/settings.json': '' });
    assert.equal(reader.read('.gemini/settings.json'), '');
    assert.equal(reader.exists('.gemini/settings.json'), true);
  });
});
