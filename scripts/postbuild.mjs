// Ensure dist/cli.js has a shebang and is executable. TypeScript strips shebangs
// from emitted .js, so we re-add it here.
import { readFile, writeFile, chmod } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(here, '..', 'dist', 'cli.js');

const SHEBANG = '#!/usr/bin/env node\n';

const body = await readFile(cliPath, 'utf8');
if (!body.startsWith(SHEBANG)) {
  await writeFile(cliPath, SHEBANG + body, 'utf8');
}
await chmod(cliPath, 0o755);
