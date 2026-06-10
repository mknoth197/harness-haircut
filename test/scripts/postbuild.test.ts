import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { statSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const binPath = resolve(here, '..', '..', 'dist', 'bin.js');

// npm test always builds first, so dist/bin.js must exist and carry the
// postbuild fixups. These assertions protect against postbuild regressions
// (a broken shebang or lost exec bit ships a binary npx cannot run).
describe('postbuild output', () => {
  it('dist/bin.js starts with the node shebang', () => {
    const firstLine = readFileSync(binPath, 'utf8').split('\n', 1)[0];
    assert.equal(firstLine, '#!/usr/bin/env node');
  });

  it('dist/bin.js is executable', () => {
    const mode = statSync(binPath).mode;
    assert.ok(mode & 0o111, `expected an executable bit, got mode ${mode.toString(8)}`);
  });
});
