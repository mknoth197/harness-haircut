#!/usr/bin/env node
import { run } from './cli.js';

run(process.argv.slice(2), { stdout: process.stdout, stderr: process.stderr })
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    process.stderr.write(`harness-haircut: ${err instanceof Error ? err.message : String(err)}\n`);
    process.exit(70);
  });
