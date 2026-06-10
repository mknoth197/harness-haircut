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

  // Windows synthesizes mode bits from file extensions and chmod is a no-op
  // there, so the exec-bit assertion only holds on POSIX.
  it('dist/bin.js is executable', { skip: process.platform === 'win32' }, () => {
    const mode = statSync(binPath).mode;
    assert.notEqual(mode & 0o111, 0);
  });
});
