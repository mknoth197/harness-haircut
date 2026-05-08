// Ensure dist/bin.js has a shebang and is executable. TypeScript strips shebangs
// from emitted .js, so we re-add it here.
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const binPath = resolve(here, '..', 'dist', 'bin.js');

const SHEBANG = '#!/usr/bin/env node\n';

const body = await readFile(binPath, 'utf8');
if (!body.startsWith(SHEBANG)) {
  await writeFile(binPath, SHEBANG + body, 'utf8');
}
await chmod(binPath, 0o755);
