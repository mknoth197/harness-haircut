import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { DomainError, InvalidConfigError } from './entities/errors.js';
import type { ProviderId, ProjectionContext } from './entities/adapter.js';
import { createProviderFileReader } from './gateways/provider-files.js';
import { createAllAdapters } from './adapters/index.js';
import { parseRepo } from './use-cases/parse-repo.js';
import { readRepoSnapshot } from './gateways/filesystem.js';
import { loadConfig, enabledProviders } from './use-cases/load-config.js';
import type { HarnessConfig } from './use-cases/load-config.js';
import { audit } from './use-cases/audit.js';
import type { AuditReport, FileAudit } from './use-cases/audit.js';

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
    '  --strict            Treat any warning as a failure (exit 1)',
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

  if (parsed.command === 'audit') {
    return runAudit(parsed, io);
  }

  // init / apply / doctor are stubs until C2/C3/their stories land.
  io.stderr.write(`harness-haircut: '${parsed.command}' not yet implemented\n`);
  return 70;
}

const DRIFT_LABELS: Readonly<Record<FileAudit['status'], string>> = {
  clean: 'clean',
  'drift:edited': 'edited',
  'drift:stale': 'stale',
  'drift:missing': 'missing',
  'drift:unmanaged': 'unmanaged',
  'drift:differs': 'differs',
};

/**
 * Reads the optional `harness-haircut.config.json`. An absent file yields
 * defaults; a present-but-malformed file throws `InvalidConfigError` (exit 3)
 * via `loadConfig`. `--config <path>` overrides the default location.
 */
async function readConfig(cwd: string, configFlag: string | undefined): Promise<HarnessConfig> {
  const explicit = configFlag !== undefined;
  const configPath = explicit
    ? resolve(cwd, configFlag)
    : resolve(cwd, 'harness-haircut.config.json');
  let raw: string | null;
  try {
    raw = await readFile(configPath, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      // Default location absent → defaults. An explicit --config that does
      // not exist is a user error worth surfacing as invalid config.
      if (explicit) {
        throw new InvalidConfigError(configPath, 'config file not found');
      }
      raw = null;
    } else {
      throw err;
    }
  }
  return loadConfig(raw, explicit ? configPath : 'harness-haircut.config.json');
}

async function runAudit(parsed: ParsedArgs, io: RunIO): Promise<ExitCode> {
  const cwdFlag = parsed.flags['--cwd'];
  const cwd = typeof cwdFlag === 'string' ? resolve(cwdFlag) : process.cwd();
  const configFlag = typeof parsed.flags['--config'] === 'string'
    ? (parsed.flags['--config'] as string)
    : undefined;
  const json = parsed.flags['--json'] === true;
  const strict = parsed.flags['--strict'] === true;

  let report: AuditReport;
  try {
    const config = await readConfig(cwd, configFlag);
    const reader = createProviderFileReader(cwd);
    const enabled = enabledProviders(config);
    const adapters = createAllAdapters().filter((adapter) => enabled.includes(adapter.id));
    const contextFor = (id: ProviderId): ProjectionContext => {
      const ctx: ProjectionContext = { cwd, providerFiles: reader };
      if (id === 'gemini') {
        ctx.providerConfig = { mode: config.gemini.mode };
      }
      return ctx;
    };
    report = await audit({
      parse: () => parseRepo({ readRepo: () => readRepoSnapshot(cwd) }),
      adapters,
      reader,
      contextFor,
      strict: strict || config.warningsAsErrors,
    });
  } catch (err) {
    if (err instanceof DomainError) {
      io.stderr.write(`harness-haircut: ${err.message}\n`);
      // Map the domain error's exit code into the audit table; anything
      // outside 1–3 (e.g. an internal 70) is surfaced as a system error.
      return err.exitCode === 3 ? 3 : err.exitCode === 1 ? 1 : 70;
    }
    throw err;
  }

  if (json) {
    io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    io.stdout.write(renderAuditReport(report));
  }
  return report.exitCode;
}

function renderAuditReport(report: AuditReport): string {
  const lines: string[] = [];
  const drifted = report.files.filter((file) => file.status !== 'clean');

  if (report.files.length === 0) {
    lines.push('No provider files expected.');
  } else if (drifted.length === 0) {
    lines.push(`clean — ${report.files.length} file(s) match canonical sources`);
  } else {
    lines.push(`drift — ${drifted.length} of ${report.files.length} file(s) diverge:`);
    for (const file of drifted) {
      const keyNote = file.mergeKey !== undefined ? ` (key: ${file.mergeKey})` : '';
      lines.push(`  ${DRIFT_LABELS[file.status]}\t${file.path} [${file.providerId}]${keyNote}`);
    }
  }

  if (report.warnings.length > 0) {
    lines.push('');
    lines.push(`${report.warnings.length} warning(s):`);
    for (const warning of report.warnings) {
      const where = warning.canonicalPath ?? warning.providerId ?? '';
      const suffix = where === '' ? '' : ` (${where})`;
      lines.push(`  ${warning.code}\t${warning.message}${suffix}`);
    }
  }

  lines.push('');
  return `${lines.join('\n')}`;
}
