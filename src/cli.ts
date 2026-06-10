import { readFile } from 'node:fs/promises';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { DomainError, InvalidConfigError } from './entities/errors.js';
import type { ProviderId, ProjectionContext } from './entities/adapter.js';
import { APPLY_STATE_PATH, parseState, serializeState } from './entities/apply-state.js';
import type { ApplyState } from './entities/apply-state.js';
import { createProviderFileReader } from './gateways/provider-files.js';
import { createFileWriter } from './gateways/fs-writer.js';
import { isWorkingTreeDirty } from './gateways/git.js';
import { createAllAdapters } from './adapters/index.js';
import { parseRepo } from './use-cases/parse-repo.js';
import { readRepoSnapshot, readInitSnapshot } from './gateways/filesystem.js';
import { loadConfig, enabledProviders } from './use-cases/load-config.js';
import type { HarnessConfig } from './use-cases/load-config.js';
import { audit } from './use-cases/audit.js';
import type { AuditReport, FileAudit } from './use-cases/audit.js';
import { apply } from './use-cases/apply.js';
import type { ApplyReport } from './use-cases/apply.js';
import { init } from './use-cases/init.js';
import type { InitReport } from './use-cases/init.js';
import type { Contradiction, Resolution } from './entities/contradiction.js';

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
    'init options:',
    '  --dry-run           Print the planned canonical layout and exit without writing',
    '  --non-interactive   Never prompt; fail (exit 1) on any unresolved contradiction',
    '',
    'apply options:',
    '  --dry-run           Print the would-emit plan and exit without writing',
    '  --allow-dirty       Run even when the git working tree is dirty',
    '  --non-interactive   Never prompt; fail (exit 1) on a user-edited file',
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

  if (parsed.command === 'apply') {
    return runApply(parsed, io);
  }

  if (parsed.command === 'init') {
    return runInit(parsed, io);
  }

  // doctor is a stub until its story lands.
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

/**
 * Interactive overwrite prompt for an `edited` file (UN1). Reads a single
 * y/N answer from stdin; anything other than `y`/`yes` (case-insensitive)
 * declines, so a bare Enter is safe. `--non-interactive` bypasses this
 * entirely (the use case auto-declines), so this is only constructed for an
 * interactive run.
 */
function readlineConfirm(io: RunIO): (path: string) => Promise<boolean> {
  return (path: string) =>
    new Promise<boolean>((resolveAnswer) => {
      const rl = createInterface({ input: process.stdin, output: io.stdout });
      rl.question(
        `harness-haircut: ${path} was edited since it was generated. Overwrite? [y/N] `,
        (answer) => {
          rl.close();
          const normalized = answer.trim().toLowerCase();
          resolveAnswer(normalized === 'y' || normalized === 'yes');
        },
      );
    });
}

async function runApply(parsed: ParsedArgs, io: RunIO): Promise<ExitCode> {
  const cwdFlag = parsed.flags['--cwd'];
  const cwd = typeof cwdFlag === 'string' ? resolve(cwdFlag) : process.cwd();
  const configFlag =
    typeof parsed.flags['--config'] === 'string' ? (parsed.flags['--config'] as string) : undefined;
  const json = parsed.flags['--json'] === true;
  const dryRun = parsed.flags['--dry-run'] === true;
  const allowDirty = parsed.flags['--allow-dirty'] === true;
  const nonInteractive = parsed.flags['--non-interactive'] === true;

  let report: ApplyReport;
  try {
    const config = await readConfig(cwd, configFlag);
    const reader = createProviderFileReader(cwd);
    const writer = createFileWriter(cwd);
    const enabled = enabledProviders(config);
    const adapters = createAllAdapters().filter((adapter) => enabled.includes(adapter.id));
    const contextFor = (id: ProviderId): ProjectionContext => {
      const ctx: ProjectionContext = { cwd, providerFiles: reader };
      if (id === 'gemini') {
        ctx.providerConfig = { mode: config.gemini.mode };
      }
      return ctx;
    };
    report = await apply({
      parse: () => parseRepo({ readRepo: () => readRepoSnapshot(cwd) }),
      adapters,
      reader,
      writer,
      contextFor,
      isDirty: () => isWorkingTreeDirty(cwd),
      // Under --non-interactive the use case never calls confirm, so a
      // no-prompt stub is correct; otherwise wire the readline prompt.
      confirm: nonInteractive ? () => Promise.resolve(false) : readlineConfirm(io),
      readState: (): ApplyState => parseState(reader.read(APPLY_STATE_PATH)),
      writeState: (state: ApplyState): void => writer.write(APPLY_STATE_PATH, serializeState(state)),
      flags: { allowDirty, dryRun, nonInteractive },
    });
  } catch (err) {
    if (err instanceof DomainError) {
      io.stderr.write(`harness-haircut: ${err.message}\n`);
      return err.exitCode === 3 ? 3 : err.exitCode === 1 ? 1 : 70;
    }
    throw err;
  }

  if (json) {
    io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    io.stdout.write(renderApplyReport(report));
  }
  return report.exitCode;
}

function renderApplyReport(report: ApplyReport): string {
  const lines: string[] = [];

  if (report.refused === 'dirty-tree') {
    lines.push(
      'refused — the git working tree has uncommitted changes. Commit or stash ' +
        'them, or re-run with --allow-dirty.',
    );
    lines.push('');
    return lines.join('\n');
  }

  const verb = report.dryRun ? 'would write' : 'wrote';
  if (report.written.length === 0 && report.blocked.length === 0) {
    lines.push('nothing to do');
  } else {
    if (report.written.length > 0) {
      lines.push(`${verb} ${report.written.length} file(s):`);
      for (const file of report.files.filter((f) => f.action === 'written')) {
        const keyNote = file.mergeKey !== undefined ? ` (key: ${file.mergeKey})` : '';
        lines.push(`  ${file.reason}\t${file.path} [${file.providerId}]${keyNote}`);
      }
    }
    if (report.blocked.length > 0) {
      lines.push(`blocked ${report.blocked.length} edited file(s) (not overwritten):`);
      for (const file of report.files.filter((f) => f.action === 'blocked')) {
        lines.push(`  edited\t${file.path} [${file.providerId}]`);
      }
    }
  }
  if (report.skipped.length > 0) {
    lines.push(`skipped ${report.skipped.length} unchanged file(s)`);
  }
  // U1 transparency: a real apply that wrote anything also updates the
  // committed state baseline. Name it so the only non-adapter path apply
  // touches is never a surprise.
  if (!report.dryRun && report.written.length > 0) {
    lines.push(`updated state baseline ${APPLY_STATE_PATH} (commit alongside the changes above)`);
  }
  if (report.dryRun) {
    lines.push('(dry run — no files written)');
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
  return lines.join('\n');
}

/**
 * Interactive contradiction resolver for `init` (C3 EV2/EV3) over
 * `node:readline` — a numbered-choice prompt rather than the `prompts` /
 * `@inquirer/prompts` dependency the story names, to keep PRD goal 5's
 * zero-runtime-deps promise. The use case (layer 2) stays pure; this layer-4
 * function is the only place that touches stdin. It lists each candidate
 * (provider + path + a short preview) plus a final "skip / write blank"
 * option, reads one number, and maps it to a `Resolution`. An out-of-range
 * answer, empty input, or EOF (Ctrl-D / piped stdin exhausted) resolves to
 * `{ kind: 'unresolved' }`, which fails the run (OPT1) without writing.
 */
function readlineResolver(io: RunIO): (contradiction: Contradiction) => Promise<Resolution> {
  return (contradiction: Contradiction): Promise<Resolution> =>
    new Promise<Resolution>((resolveAnswer) => {
      const rl = createInterface({ input: process.stdin, output: io.stdout });
      const lines: string[] = [];
      lines.push(`Contradiction in "${contradiction.slot}" — pick the canonical answer:`);
      contradiction.candidates.forEach((candidate, index) => {
        const preview = candidate.text.replace(/\s+/g, ' ').trim().slice(0, 60);
        lines.push(`  ${index + 1}) ${candidate.providerId} (${candidate.path}): ${preview}`);
      });
      const skipChoice = contradiction.candidates.length + 1;
      lines.push(`  ${skipChoice}) skip / write blank for this slot`);
      io.stdout.write(`${lines.join('\n')}\n`);
      rl.question(`Choice [1-${skipChoice}]: `, (answer) => {
        rl.close();
        const n = Number.parseInt(answer.trim(), 10);
        if (!Number.isInteger(n) || n < 1 || n > skipChoice) {
          resolveAnswer({ kind: 'unresolved' });
          return;
        }
        if (n === skipChoice) {
          resolveAnswer({ kind: 'skip' });
          return;
        }
        resolveAnswer({ kind: 'choose', index: n - 1 });
      });
    });
}

async function runInit(parsed: ParsedArgs, io: RunIO): Promise<ExitCode> {
  const cwdFlag = parsed.flags['--cwd'];
  const cwd = typeof cwdFlag === 'string' ? resolve(cwdFlag) : process.cwd();
  const configFlag =
    typeof parsed.flags['--config'] === 'string' ? (parsed.flags['--config'] as string) : undefined;
  const json = parsed.flags['--json'] === true;
  const dryRun = parsed.flags['--dry-run'] === true;
  const nonInteractive = parsed.flags['--non-interactive'] === true;

  let report: InitReport;
  try {
    const config = await readConfig(cwd, configFlag);
    const reader = createProviderFileReader(cwd);
    const writer = createFileWriter(cwd);
    const enabled = enabledProviders(config);
    const adapters = createAllAdapters().filter((adapter) => enabled.includes(adapter.id));
    const contextFor = (id: ProviderId): ProjectionContext => {
      const ctx: ProjectionContext = { cwd, providerFiles: reader };
      if (id === 'gemini') {
        ctx.providerConfig = { mode: config.gemini.mode };
      }
      return ctx;
    };
    report = await init({
      snapshot: () => readInitSnapshot(cwd),
      reader,
      writer,
      adapters,
      // --non-interactive never reaches a prompt (the use case fails first on
      // any contradiction), so a no-prompt stub is correct there; otherwise
      // wire the readline numbered-choice prompt.
      resolveContradiction: nonInteractive
        ? () => Promise.resolve<Resolution>({ kind: 'unresolved' })
        : readlineResolver(io),
      // C3 reuses C2. init has just written canonical files, so the tree is
      // expected dirty during onboarding — apply runs with allowDirty so the
      // freshly-written canonical layout is projected. The init-level prompt
      // already resolved everything; apply finds only freshly-written
      // canonical files, so its own edited-file prompt should never fire, but
      // a non-interactive stub keeps it from blocking on a surprise.
      apply: () =>
        apply({
          parse: () => parseRepo({ readRepo: () => readRepoSnapshot(cwd) }),
          adapters,
          reader,
          writer,
          contextFor,
          isDirty: () => isWorkingTreeDirty(cwd),
          confirm: () => Promise.resolve(false),
          readState: (): ApplyState => parseState(reader.read(APPLY_STATE_PATH)),
          writeState: (state: ApplyState): void =>
            writer.write(APPLY_STATE_PATH, serializeState(state)),
          flags: { allowDirty: true, dryRun, nonInteractive: true },
        }),
      flags: { dryRun, nonInteractive },
    });
  } catch (err) {
    if (err instanceof DomainError) {
      io.stderr.write(`harness-haircut: ${err.message}\n`);
      return err.exitCode === 3 ? 3 : err.exitCode === 1 ? 1 : 70;
    }
    throw err;
  }

  if (json) {
    io.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } else {
    io.stdout.write(renderInitReport(report));
  }
  return report.exitCode;
}

function renderInitReport(report: InitReport): string {
  const lines: string[] = [];

  if (report.refused === 'already-canonical') {
    lines.push('refused — this repo is already canonical (run `harness-haircut apply` instead).');
    for (const note of report.notes) {
      lines.push(`  ${note}`);
    }
    lines.push('');
    return lines.join('\n');
  }

  if (report.detected.length > 0) {
    lines.push(`detected ${report.detected.length} existing provider config(s):`);
    for (const config of report.detected) {
      lines.push(`  ${config.providerId}\t${config.paths.join(', ')}`);
    }
  } else {
    lines.push('no existing provider config detected.');
  }

  if (report.contradictions.length > 0) {
    lines.push('');
    if (report.refused === 'unresolved-contradictions') {
      lines.push(`refused — ${report.contradictions.length} unresolved contradiction(s):`);
    } else {
      lines.push(`resolved ${report.contradictions.length} contradiction(s):`);
    }
    for (const contradiction of report.contradictions) {
      const sources = contradiction.candidates
        .map((candidate) => `${candidate.providerId} (${candidate.path})`)
        .join(' vs ');
      lines.push(`  ${contradiction.slot}: ${sources}`);
    }
  }

  if (report.planned.length > 0) {
    lines.push('');
    const verb = report.dryRun ? 'would write' : 'wrote';
    lines.push(`${verb} ${report.planned.length} canonical file(s):`);
    for (const file of report.planned) {
      lines.push(`  ${file.path}\t[${file.origin}]`);
    }
  }

  if (report.apply !== undefined) {
    lines.push('');
    lines.push(
      `projected ${report.apply.written.length} provider file(s) via apply ` +
        `(exit ${report.apply.exitCode}).`,
    );
  }

  if (report.notes.length > 0) {
    lines.push('');
    lines.push('notes:');
    for (const note of report.notes) {
      lines.push(`  ${note}`);
    }
  }

  if (report.dryRun) {
    lines.push('');
    lines.push('(dry run — no files written)');
  }

  lines.push('');
  return lines.join('\n');
}
