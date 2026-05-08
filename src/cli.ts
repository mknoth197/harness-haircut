import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

export type ExitCode = 0 | 1 | 2 | 3 | 64 | 70;

export interface ParsedArgs {
  command: string | null;
  flags: Record<string, string | boolean>;
  positional: string[];
  /** Set when argv could not be parsed (e.g. value-flag missing its value). */
  error?: string;
}

const KNOWN_COMMANDS = new Set(['init', 'audit', 'apply', 'doctor']);

const VALUE_FLAGS = new Set(['--cwd', '--config']);

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const positional: string[] = [];
  let command: string | null = null;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        flags[arg.slice(0, eq)] = arg.slice(eq + 1);
      } else if (VALUE_FLAGS.has(arg)) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('-')) {
          return { command, flags, positional, error: `missing value for ${arg}` };
        }
        flags[arg] = next;
        i += 1;
      } else {
        flags[arg] = true;
      }
    } else if (arg.startsWith('-') && arg.length > 1) {
      flags[arg] = true;
    } else if (command === null) {
      command = arg;
    } else {
      positional.push(arg);
    }
  }

  return { command, flags, positional };
}

async function readPackageVersion(): Promise<string> {
  const here = dirname(fileURLToPath(import.meta.url));
  const pkgPath = resolve(here, '..', 'package.json');
  const raw = await readFile(pkgPath, 'utf8');
  const pkg = JSON.parse(raw) as { version?: string };
  return pkg.version ?? '0.0.0';
}

function helpText(): string {
  return [
    'harness-haircut — audit and consolidate AI-provider configuration files',
    '',
    'Usage:',
    '  harness-haircut <command> [options]',
    '',
    'Commands:',
    '  init       Bootstrap canonical layout from an existing repo (interactive merge)',
    '  audit      Read-only drift check; exits non-zero on any divergence or warning',
    '  apply      Project canonical sources into provider-specific files',
    '  doctor     Print configuration, detected providers, and version info',
    '',
    'Global options:',
    '  --cwd <path>        Run as if invoked in <path> (default: process.cwd())',
    '  --config <path>     Path to harness-haircut.config.json',
    '  --json              Emit machine-readable JSON to stdout',
    '  --no-color          Disable colored output',
    '  -v, --verbose       Verbose logging',
    '  -h, --help          Show help',
    '  --version           Show version',
    '',
    'See https://github.com/mknoth197/harness-haircut for documentation.',
  ].join('\n');
}

export interface RunIO {
  stdout: NodeJS.WritableStream;
  stderr: NodeJS.WritableStream;
}

export async function run(argv: readonly string[], io: RunIO): Promise<ExitCode> {
  const parsed = parseArgs(argv);

  if (parsed.error !== undefined) {
    io.stderr.write(`harness-haircut: ${parsed.error}\n`);
    io.stderr.write(`Run 'harness-haircut --help' for usage.\n`);
    return 64;
  }

  if (parsed.flags['--version']) {
    io.stdout.write(`${await readPackageVersion()}\n`);
    return 0;
  }

  if (parsed.flags['--help'] || parsed.flags['-h'] || parsed.command === null) {
    io.stdout.write(`${helpText()}\n`);
    return 0;
  }

  if (!KNOWN_COMMANDS.has(parsed.command)) {
    io.stderr.write(`harness-haircut: unknown command "${parsed.command}"\n`);
    io.stderr.write(`Run 'harness-haircut --help' for usage.\n`);
    return 64;
  }

  // Commands are stubs in F0; the real implementations land in C1/C2/C3 stories.
  io.stderr.write(`harness-haircut: '${parsed.command}' not yet implemented\n`);
  return 70;
}
