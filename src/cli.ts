import { execFile } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { DomainError, InvalidConfigError } from './entities/errors.js';
import type { ProviderId, ProjectionContext } from './entities/adapter.js';
import {
  checkEndpointPolicy,
  renderEgressDisclosure,
  renderEgressPreview,
  EGRESS_CONSENT_PROMPT,
  APPLY_BACKUP_DIR,
  INIT_BACKUP_DIR,
  sanitizeBackupName,
} from './entities/index.js';
import type {
  CandidateText,
  EgressDestination,
  EgressFlags,
  EgressPlan,
} from './entities/index.js';
import {
  createDiscoveryProbes,
  discoverCredentialSources,
} from './gateways/ai-credentials.js';
import type { CredentialSource } from './gateways/ai-credentials.js';
import { buildAiResolver } from './gateways/ai-resolver.js';
import type { AssistBackend } from './gateways/ai-resolver.js';
import {
  createCliBackend,
  createSdkBackend,
  AssistBackendUnavailableError,
} from './gateways/assist-backends.js';
import type { CliSpawn } from './gateways/assist-backends.js';
import {
  assistStorePath,
  readRememberedSource,
  writeRememberedSource,
} from './gateways/assist-persistence.js';
import { APPLY_STATE_PATH, parseState, serializeState } from './entities/apply-state.js';
import type { ApplyState } from './entities/apply-state.js';
import { createProviderFileReader } from './gateways/provider-files.js';
import { createFileWriter, createSymlinkAliasProbe } from './gateways/fs-writer.js';
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
import { installPrecommit } from './use-cases/install-precommit.js';
import type { InstallReport } from './use-cases/install-precommit.js';
import { createPrecommitGateway } from './gateways/precommit.js';
import { doctor } from './use-cases/doctor.js';
import type { DoctorReport } from './use-cases/doctor.js';
import type { Contradiction, ContradictionResolver, Resolution } from './entities/contradiction.js';

export type ExitCode = 0 | 1 | 2 | 3 | 64 | 70;

export interface ParsedArgs {
  command: string | null;
  flags: Record<string, string | boolean>;
  positional: string[];
  /** Repeatable value flags accumulated across occurrences (e.g. `--assist-include`). */
  repeated: Record<string, string[]>;
  /** Set when argv could not be parsed (e.g. value-flag missing its value). */
  error?: string;
}

const KNOWN_COMMANDS = new Set(['init', 'audit', 'apply', 'doctor', 'install-precommit']);

const VALUE_FLAGS = new Set(['--cwd', '--config', '--assist-model', '--fail-on']);

/** Value flags that may appear more than once; values accumulate into `repeated`. */
const REPEATABLE_VALUE_FLAGS = new Set(['--assist-include', '--assist-allow-secret']);

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const flags: Record<string, string | boolean> = {};
  const repeated: Record<string, string[]> = {};
  const positional: string[] = [];
  let command: string | null = null;

  const pushRepeated = (key: string, value: string): void => {
    (repeated[key] ??= []).push(value);
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg.startsWith('--')) {
      const eq = arg.indexOf('=');
      if (eq !== -1) {
        const key = arg.slice(0, eq);
        const value = arg.slice(eq + 1);
        if (REPEATABLE_VALUE_FLAGS.has(key)) {
          pushRepeated(key, value);
        } else {
          flags[key] = value;
        }
      } else if (REPEATABLE_VALUE_FLAGS.has(arg)) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('-')) {
          return { command, flags, positional, repeated, error: `missing value for ${arg}` };
        }
        pushRepeated(arg, next);
        i += 1;
      } else if (VALUE_FLAGS.has(arg)) {
        const next = argv[i + 1];
        if (next === undefined || next.startsWith('-')) {
          return { command, flags, positional, repeated, error: `missing value for ${arg}` };
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

  return { command, flags, positional, repeated };
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
    '  audit      Read-only drift check; exits 1 on drift, 2 on a lossy warning',
    '  apply      Project canonical sources into provider-specific files',
    '  doctor     Print configuration, detected providers, and version info',
    '  install-precommit  Install a git pre-commit hook that runs `audit`',
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
    'audit options:',
    '  --fail-on <level>   "warn" (default): a lossy-translation warning exits 2.',
    '                      "drift": only real drift (exit 1) or invalid config',
    '                      (exit 3) fail; a warnings-only run exits 0 (the',
    '                      warnings still print). Use in CI to tolerate standing',
    '                      HH-Wxxx warnings the way the pre-commit hook does.',
    '                      As an explicit per-run directive, "drift" overrides',
    '                      both --strict and config warningsAsErrors for warnings.',
    '',
    'init options:',
    '  --dry-run           Print the planned canonical layout and exit without writing',
    '  --non-interactive   Never prompt; fail (exit 1) on any unresolved contradiction',
    '  --adopt             Adopt an existing HAND-BUILT .agents/ tree as canonical and',
    '                      consolidate the remaining provider files into it (does not',
    '                      apply to a tool-managed repo — use `apply` for those)',
    '  --assist            Opt-in AI-assisted merge (discovers a credential source and',
    '                      proposes a semantic merge; every send is disclosed, every',
    '                      merge human-approved). Cannot combine with --non-interactive.',
    '  --assist-include <glob>       Also send a normally-withheld file class (repeatable)',
    '  --assist-allow-secret <rule>  Redact (not block) a matched secret rule (repeatable)',
    '  --assist-model <id>           Override the model for the chosen backend',
    '  --assist-yes        Pre-approve egress for the run (the disclosure still prints)',
    '  --no-preview        Suppress the post-redaction body preview (list/counts still show)',
    '',
    'apply options:',
    '  --dry-run           Print the would-emit plan and exit without writing',
    '  --allow-dirty       Run even when the git working tree is dirty',
    '  --non-interactive   Never prompt; fail (exit 1) on a user-edited or',
    '                      hand-written (unmanaged) provider file',
    '',
    'install-precommit options:',
    '  --force             Overwrite an existing pre-commit hook (else append)',
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

  if (parsed.command === 'install-precommit') {
    return runInstallPrecommit(parsed, io);
  }

  if (parsed.command === 'doctor') {
    return runDoctor(parsed, io);
  }

  // Every known command is dispatched above; this is unreachable but keeps the
  // function total for the type checker.
  io.stderr.write(`harness-haircut: '${parsed.command}' not yet implemented\n`);
  return 70;
}

async function runInstallPrecommit(parsed: ParsedArgs, io: RunIO): Promise<ExitCode> {
  const cwdFlag = parsed.flags['--cwd'];
  const cwd = typeof cwdFlag === 'string' ? resolve(cwdFlag) : process.cwd();
  const json = parsed.flags['--json'] === true;
  const force = parsed.flags['--force'] === true;

  let report: InstallReport;
  try {
    report = installPrecommit({
      gateway: createPrecommitGateway(cwd),
      flags: { force },
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
  } else if (report.exitCode === 3) {
    io.stderr.write(
      'harness-haircut: not a git repository, or `git` is not installed, so the ' +
        'hooks directory could not be resolved. Run `git init` first, run from ' +
        'the repo root (including a worktree or submodule), and ensure `git` is ' +
        'on PATH.\n',
    );
  } else {
    const verb: Record<InstallReport['action'], string> = {
      created: 'installed pre-commit hook',
      overwritten: 'overwrote pre-commit hook',
      appended: 'appended harness block to existing pre-commit hook',
      unchanged: 'pre-commit hook already up to date',
    };
    io.stdout.write(`${verb[report.action]}: ${report.target}\n`);
  }
  return report.exitCode;
}

async function runDoctor(parsed: ParsedArgs, io: RunIO): Promise<ExitCode> {
  const cwdFlag = parsed.flags['--cwd'];
  const cwd = typeof cwdFlag === 'string' ? resolve(cwdFlag) : process.cwd();
  const configFlag =
    typeof parsed.flags['--config'] === 'string' ? (parsed.flags['--config'] as string) : undefined;
  const json = parsed.flags['--json'] === true;

  let report: DoctorReport;
  try {
    // Read the raw config text (or null when absent) here in layer 4; the use
    // case parses it so an invalid config surfaces as the doctor's exit 3.
    const { raw, configPath, explicitConfigMissing } = await readConfigText(cwd, configFlag);
    // #42: detection should honor the `exclude` globs too, but doctor reads RAW
    // config (it diagnoses an invalid one rather than throwing). Best-effort
    // parse for the snapshot only: a bad config yields no exclude here and is
    // still reported by the use case.
    let doctorExclude: string[] = [];
    try {
      doctorExclude = loadConfig(raw, configPath).exclude;
    } catch {
      // invalid config — the use case surfaces it as exit 3; no exclude to apply.
    }
    // Reuse the same paid-call-free discovery `init --assist` uses, so doctor
    // reports the available AI-assist credential sources WITHOUT a model call.
    const assistSources = discoverCredentialSources(createDiscoveryProbes()).map((source) => ({
      provider: source.provider,
      kind: source.kind,
      caveat: source.caveat,
      detail: source.detail,
    }));
    report = await doctor({
      version: await readPackageVersion(),
      nodeVersion: process.version,
      cwd,
      adapters: createAllAdapters(),
      snapshot: () => readInitSnapshot(cwd, doctorExclude),
      configRaw: raw,
      configPath,
      explicitConfigMissing,
      assistSources,
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
    io.stdout.write(renderDoctorReport(report));
  }
  return report.exitCode;
}

function renderDoctorReport(report: DoctorReport): string {
  const lines: string[] = [];
  lines.push('harness-haircut doctor');
  lines.push(`  version       ${report.version}`);
  lines.push(`  node          ${report.nodeVersion}`);
  lines.push(`  cwd           ${report.cwd}`);
  lines.push('');
  if (report.detectedProviders.length > 0) {
    lines.push(`detected ${report.detectedProviders.length} provider config(s):`);
    for (const provider of report.detectedProviders) {
      lines.push(`  ${provider.providerId}\t${provider.paths.join(', ')}`);
    }
  } else {
    lines.push('no existing provider config detected.');
  }
  lines.push('');
  if (report.config === null) {
    lines.push('config: invalid (see warnings)');
  } else {
    const enabled = report.config.providers ?? 'all';
    lines.push('config:');
    lines.push(`  providers     ${Array.isArray(enabled) ? enabled.join(', ') : enabled}`);
    lines.push(`  disabled      ${report.config.providersDisabled.join(', ') || '(none)'}`);
    lines.push(`  exclude       ${report.config.exclude.join(', ') || '(none)'}`);
    lines.push(`  gemini.mode   ${report.config.gemini.mode}`);
    lines.push(`  warningsAsErrors ${report.config.warningsAsErrors}`);
  }
  lines.push('');
  if (report.assistSources.length > 0) {
    lines.push(`AI-assist sources (for \`init --assist\`; nothing is sent without consent):`);
    for (const source of report.assistSources) {
      lines.push(`  ${source.provider} [${source.kind}]  ${source.detail}`);
      lines.push(`    caveat: ${source.caveat}`);
    }
  } else {
    lines.push('AI-assist sources: none discovered (set a provider API key or log in to a provider CLI).');
  }
  if (report.warnings.length > 0) {
    lines.push('');
    lines.push(`${report.warnings.length} warning(s):`);
    for (const warning of report.warnings) {
      lines.push(`  ${warning}`);
    }
  }
  lines.push('');
  return lines.join('\n');
}

const DRIFT_LABELS: Readonly<Record<FileAudit['status'], string>> = {
  clean: 'clean',
  'drift:edited': 'edited',
  'drift:stale': 'stale',
  'drift:missing': 'missing',
  'drift:unmanaged': 'unmanaged',
  'drift:differs': 'differs',
  aliased: 'aliased',
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

/**
 * Reads the raw config text without parsing it, for `doctor` (which diagnoses
 * an invalid config rather than throwing on it). Returns `null` raw when the
 * file is absent. The default-location absence is silent (doctor falls back to
 * defaults); an explicit `--config <path>` that does not exist sets
 * `explicitConfigMissing` so doctor can surface it as a warning rather than
 * silently defaulting.
 */
async function readConfigText(
  cwd: string,
  configFlag: string | undefined,
): Promise<{ raw: string | null; configPath: string; explicitConfigMissing: boolean }> {
  const explicit = configFlag !== undefined;
  const configPath = explicit
    ? resolve(cwd, configFlag)
    : resolve(cwd, 'harness-haircut.config.json');
  try {
    const raw = await readFile(configPath, 'utf8');
    return { raw, configPath, explicitConfigMissing: false };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { raw: null, configPath, explicitConfigMissing: explicit };
    }
    throw err;
  }
}

async function runAudit(parsed: ParsedArgs, io: RunIO): Promise<ExitCode> {
  const cwdFlag = parsed.flags['--cwd'];
  const cwd = typeof cwdFlag === 'string' ? resolve(cwdFlag) : process.cwd();
  const configFlag = typeof parsed.flags['--config'] === 'string'
    ? (parsed.flags['--config'] as string)
    : undefined;
  const json = parsed.flags['--json'] === true;
  const strict = parsed.flags['--strict'] === true;
  // #43: `--fail-on drift` makes a warnings-only run exit 0 (the CI-template
  // parallel to the pre-commit hook's exit-2 tolerance). Default 'warn'.
  const failOnFlag = parsed.flags['--fail-on'];
  if (failOnFlag !== undefined && failOnFlag !== 'warn' && failOnFlag !== 'drift') {
    io.stderr.write(
      `harness-haircut: --fail-on must be "warn" (default) or "drift", got ${JSON.stringify(failOnFlag)}\n`,
    );
    return 64;
  }
  const failOn: 'warn' | 'drift' = failOnFlag === 'drift' ? 'drift' : 'warn';

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
      parse: () => parseRepo({ readRepo: () => readRepoSnapshot(cwd, config.exclude) }),
      adapters,
      reader,
      contextFor,
      aliasOf: createSymlinkAliasProbe(cwd),
      strict: strict || config.warningsAsErrors,
      failOn,
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
  // `aliased` (#35) is neither clean nor drift — those paths were skipped, so
  // they are excluded from the clean/drift accounting and listed separately.
  const aliased = report.files.filter((file) => file.status === 'aliased');
  const managedCount = report.files.length - aliased.length;
  const drifted = report.files.filter(
    (file) => file.status !== 'clean' && file.status !== 'aliased',
  );

  if (report.files.length === 0) {
    lines.push('No provider files expected.');
  } else if (drifted.length === 0) {
    lines.push(`clean — ${managedCount} file(s) match canonical sources`);
  } else {
    lines.push(`drift — ${drifted.length} of ${managedCount} file(s) diverge:`);
    for (const file of drifted) {
      const keyNote = file.mergeKey !== undefined ? ` (key: ${file.mergeKey})` : '';
      lines.push(`  ${DRIFT_LABELS[file.status]}\t${file.path} [${file.providerId}]${keyNote}`);
    }
  }
  if (aliased.length > 0) {
    lines.push(`skipped ${aliased.length} symlink-aliased path(s) (HH-W013, not audited):`);
    for (const file of aliased) {
      lines.push(`  aliased\t${file.path} [${file.providerId}]`);
    }
  }

  // #43: an ENABLED provider whose every expected file is MISSING ON DISK has
  // no presence here. Name it with the `providers_disabled` remedy, so a
  // no-Gemini repo's "missing .gemini/settings.json" drift is not read as "I
  // must create Gemini files I don't want". A provider is absent iff it appears
  // in the report (non-aliased) but none of its files exists — `drift:missing`
  // now means the FILE is absent (a present-but-keyless merge file is
  // `drift:differs`, gauntlet fix), so this no longer false-fires for a
  // hand-kept `.gemini/settings.json` without the owned key.
  const seen = new Set<ProviderId>();
  const present = new Set<ProviderId>();
  for (const file of report.files) {
    if (file.status === 'aliased') {
      continue;
    }
    seen.add(file.providerId);
    if (file.status !== 'drift:missing') {
      present.add(file.providerId);
    }
  }
  const absentProviders = [...seen].filter((id) => !present.has(id));
  if (absentProviders.length > 0) {
    lines.push('');
    lines.push(
      `hint: ${absentProviders.length} enabled provider(s) have no files in this repo ` +
        `(${absentProviders.join(', ')}). Run \`harness-haircut apply\` to create them, or — if a ` +
        'provider is not used here — add it to `providers_disabled` in harness-haircut.config.json ' +
        'so audit stops expecting it.',
    );
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

/** Reads one trimmed answer line, given a question (see `createStdinPrompt`). */
type Prompt = (question: string) => Promise<string>;

/**
 * The ONE stdin prompt implementation for every interactive command (#39).
 * A run shares a single lazily-created readline interface whose lines WE
 * buffer, rather than calling `rl.question`, because `question` has two
 * lifecycle holes that broke real runs:
 *
 *   - lines arriving while no question is pending are dropped (piped
 *     multi-answer input like `printf '1\nn\n'` dies in the gap between two
 *     prompts while a disclosure renders);
 *   - EOF never invokes a pending question callback, so the wrapping promise
 *     dangles, the event loop drains, and Node exits 0 mid-`await` with the
 *     report silently dropped — and a LATER `question()` call on the closed
 *     interface throws ERR_USE_AFTER_CLOSE (surfaced as exit 70).
 *
 * Here every input line is queued until a prompt consumes it, and EOF
 * (`close`) resolves the pending prompt — and every later one — with `''`,
 * which each caller already maps to its safe default: unresolved
 * contradiction (refuse, exit 1), declined overwrite, declined egress
 * consent, deterministic fallback. Exhausted stdin can no longer lie with an
 * exit 0 or crash with an internal error.
 */
function createStdinPrompt(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): { prompt: Prompt; close: () => void } {
  let rl: ReturnType<typeof createInterface> | undefined;
  let closed = false;
  const buffered: string[] = [];
  const waiters: Array<(answer: string) => void> = [];
  const ensure = (): void => {
    if (rl !== undefined) {
      return;
    }
    rl = createInterface({ input, output });
    rl.on('line', (line) => {
      const waiter = waiters.shift();
      if (waiter !== undefined) {
        waiter(line.trim());
      } else {
        buffered.push(line);
      }
    });
    rl.on('close', () => {
      closed = true;
      for (const waiter of waiters.splice(0)) {
        waiter('');
      }
    });
  };
  return {
    prompt: (question: string): Promise<string> => {
      ensure();
      const line = buffered.shift();
      if (line !== undefined) {
        output.write(question);
        return Promise.resolve(line.trim());
      }
      if (closed) {
        output.write(question);
        return Promise.resolve('');
      }
      // Render the question through readline (not a bare output.write) so a
      // real terminal redraws it correctly during line editing.
      rl!.setPrompt(question);
      rl!.prompt();
      return new Promise<string>((resolveAnswer) => {
        waiters.push(resolveAnswer);
      });
    },
    close: (): void => rl?.close(),
  };
}

/**
 * Interactive overwrite confirmation (UN1) over the shared prompt. The message
 * is tailored to the case: an `edited` generated file (whose content derives
 * from canonical sources) vs an `unmanaged` hand-written file apply is about to
 * back up and take over for the first time (#40) — the latter names the backup
 * location so the user knows the original is recoverable. Anything other than
 * `y`/`yes` (case-insensitive) declines, so a bare Enter — and EOF, which
 * resolves to `''` — is safe. `--non-interactive` bypasses this entirely (the
 * use case auto-declines).
 */
function confirmOverwrite(prompt: Prompt): (path: string, reason: 'edited' | 'unmanaged') => Promise<boolean> {
  return async (path: string, reason: 'edited' | 'unmanaged'): Promise<boolean> => {
    const question =
      reason === 'unmanaged'
        ? `harness-haircut: ${path} is hand-written (no harness-haircut header) and not ` +
          `yet managed. Back up to ${APPLY_BACKUP_DIR}/${sanitizeBackupName(path)} and ` +
          `overwrite with the generated projection? [y/N] `
        : `harness-haircut: ${path} was edited since it was generated. Overwrite? [y/N] `;
    const answer = await prompt(question);
    const normalized = answer.toLowerCase();
    return normalized === 'y' || normalized === 'yes';
  };
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

  // #39: one EOF-safe stdin prompt for the whole run, created lazily on the
  // first confirmation. --non-interactive never prompts, so none is built.
  const stdinPrompt = nonInteractive ? null : createStdinPrompt(process.stdin, io.stdout);

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
      parse: () => parseRepo({ readRepo: () => readRepoSnapshot(cwd, config.exclude) }),
      adapters,
      reader,
      writer,
      contextFor,
      isDirty: () => isWorkingTreeDirty(cwd),
      // Under --non-interactive the use case never calls confirm, so a
      // no-prompt stub is correct; otherwise wire the shared stdin prompt.
      confirm: stdinPrompt === null ? () => Promise.resolve(false) : confirmOverwrite(stdinPrompt.prompt),
      readState: (): ApplyState => parseState(reader.read(APPLY_STATE_PATH)),
      writeState: (state: ApplyState): void => writer.write(APPLY_STATE_PATH, serializeState(state)),
      aliasOf: createSymlinkAliasProbe(cwd),
      // #40: a standalone apply never claims a hand-written unmanaged file
      // silently — it backs it up and prompts (or refuses under --non-interactive).
      flags: { allowDirty, dryRun, nonInteractive, claimUnmanaged: false },
    });
  } catch (err) {
    if (err instanceof DomainError) {
      io.stderr.write(`harness-haircut: ${err.message}\n`);
      return err.exitCode === 3 ? 3 : err.exitCode === 1 ? 1 : 70;
    }
    throw err;
  } finally {
    stdinPrompt?.close();
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
      lines.push(`blocked ${report.blocked.length} file(s) (not overwritten):`);
      for (const file of report.files.filter((f) => f.action === 'blocked')) {
        lines.push(`  ${file.reason}\t${file.path} [${file.providerId}]`);
      }
    }
  }
  // #40: hand-written files apply took over had their originals preserved.
  if (report.backups.length > 0) {
    lines.push(
      `preserved ${report.backups.length} hand-written file(s) before overwriting ` +
        `(originals backed up under ${APPLY_BACKUP_DIR}/):`,
    );
    for (const file of report.files.filter((f) => f.action === 'written' && f.reason === 'unmanaged')) {
      lines.push(`  ${file.path} -> ${APPLY_BACKUP_DIR}/${sanitizeBackupName(file.path)}`);
    }
  }
  const aliasedSkips = report.files.filter((file) => file.reason === 'aliased');
  const unchangedSkips = report.skipped.length - aliasedSkips.length;
  if (unchangedSkips > 0) {
    lines.push(`skipped ${unchangedSkips} unchanged file(s)`);
  }
  if (aliasedSkips.length > 0) {
    lines.push(`skipped ${aliasedSkips.length} symlink-aliased path(s) (HH-W013, not written):`);
    for (const file of aliasedSkips) {
      lines.push(`  aliased\t${file.path} [${file.providerId}]`);
    }
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
 * Multi-line candidate preview for the resolver (C3 F2): the first 12 lines
 * (capped at ~400 chars total) of the candidate's ORIGINAL text, so the choice
 * between contradicting candidates is informed rather than a 60-char teaser.
 * Trailing whitespace is trimmed and a truncation marker is appended when the
 * candidate is longer than the preview shows.
 */
function previewCandidate(text: string): string[] {
  const MAX_LINES = 12;
  const MAX_CHARS = 400;
  const allLines = text.replace(/\s+$/, '').split('\n');
  const shown = allLines.slice(0, MAX_LINES).map((line) => line.trimEnd());
  let total = 0;
  const out: string[] = [];
  for (const line of shown) {
    if (total + line.length > MAX_CHARS) {
      out.push(`${line.slice(0, Math.max(0, MAX_CHARS - total))}…`);
      total = MAX_CHARS;
      break;
    }
    out.push(line);
    total += line.length;
  }
  if (allLines.length > out.length || total >= MAX_CHARS) {
    out.push('… (truncated — see the full file)');
  }
  return out.length === 0 ? ['(empty)'] : out;
}

/**
 * Interactive contradiction resolver for `init` (C3 EV2/EV3): a numbered-choice
 * prompt over the shared `Prompt` (no `prompts`/`@inquirer` dependency, keeping
 * PRD goal 5's zero-runtime-deps promise). The use case (layer 2) stays pure;
 * this layer-4 function is the only place that maps stdin to a `Resolution`. It
 * lists each candidate (provider + path + a multi-line preview) plus a final
 * "skip / write blank" option, reads one number, and maps it. An out-of-range
 * answer, empty input, or EOF (Ctrl-D / piped stdin exhausted) resolves to
 * `{ kind: 'unresolved' }`, which fails the run (OPT1) without writing.
 */
function readlineResolver(io: RunIO, prompt: Prompt): ContradictionResolver {
  return async (contradiction: Contradiction): Promise<Resolution> => {
    const lines: string[] = [];
    lines.push(`Contradiction in "${contradiction.slot}" — pick the canonical answer:`);
    contradiction.candidates.forEach((candidate, index) => {
      const preview = previewCandidate(candidate.text);
      lines.push(`  ${index + 1}) ${candidate.providerId} (${candidate.path}):`);
      for (const previewLine of preview) {
        lines.push(`       ${previewLine}`);
      }
    });
    const skipChoice = contradiction.candidates.length + 1;
    lines.push(`  ${skipChoice}) skip / write blank for this slot`);
    io.stdout.write(`${lines.join('\n')}\n`);
    const answer = await prompt(`Choice [1-${skipChoice}]: `);
    const n = Number.parseInt(answer.trim(), 10);
    if (!Number.isInteger(n) || n < 1 || n > skipChoice) {
      return { kind: 'unresolved' };
    }
    if (n === skipChoice) {
      return { kind: 'skip' };
    }
    return { kind: 'choose', index: n - 1 };
  };
}

/** Real CLI spawn for the subscription-session backend (execFile, never a shell). */
const realCliSpawn: CliSpawn = (request) =>
  new Promise((resolveResult) => {
    const child = execFile(
      request.binary,
      [...request.args],
      {
        cwd: request.cwd,
        env: request.env,
        timeout: request.timeoutMs,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        // execFile reports a non-zero exit / spawn failure / timeout via `error`;
        // surface a non-zero exitCode so the backend treats it as a failed call.
        const code = error && typeof error.code === 'number' ? error.code : error ? 1 : 0;
        resolveResult({ stdout: stdout ?? '', stderr: stderr ?? '', exitCode: code });
      },
    );
    // Deliver the prompt on stdin so content never lands in argv or on disk.
    child.stdin?.end(request.input);
  });

/** Provider → env var names holding an API key, in precedence order (for SDK backend). */
const PROVIDER_API_KEY_ENV: Record<ProviderId, readonly string[]> = {
  claude: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
  codex: ['OPENAI_API_KEY'],
  gemini: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
  copilot: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
};

/** Builds the model-talking backend for a chosen source (SDK or CLI-headless). */
function backendForSource(
  source: CredentialSource,
  cwd: string,
  model: string | null,
): AssistBackend {
  if (source.kind === 'api-key') {
    const envName = PROVIDER_API_KEY_ENV[source.provider].find(
      (name) => (process.env[name] ?? '') !== '',
    );
    const apiKey = envName !== undefined ? (process.env[envName] ?? '') : '';
    if (apiKey === '') {
      throw new AssistBackendUnavailableError(
        `no API key found for ${source.provider} (expected one of ${PROVIDER_API_KEY_ENV[source.provider].join(', ')}).`,
      );
    }
    return createSdkBackend({
      provider: source.provider,
      model,
      apiKey,
      load: (moduleName) => import(moduleName),
    });
  }
  return createCliBackend({
    provider: source.provider,
    model,
    repoRoot: cwd,
    // A fresh empty scratch dir OUTSIDE the repo (Finding 1): the provider CLI
    // cannot auto-discover the repo's CLAUDE.md / skills / hooks / MCP.
    makeScratchDir: () => mkdtempSync(join(tmpdir(), 'hh-assist-')),
    spawn: realCliSpawn,
  });
}

/** A short unified-ish diff for the merge-approval prompt (EV2). */
function renderMergeDiff(candidates: readonly CandidateText[], proposed: string): string {
  const lines: string[] = ['AI-proposed merged text:'];
  lines.push('────────────────────────────────────');
  for (const line of proposed.split('\n')) {
    lines.push(`+ ${line}`);
  }
  lines.push('────────────────────────────────────');
  lines.push(`(supersedes ${candidates.length} candidate(s): ${candidates.map((c) => c.path).join(', ')})`);
  return lines.join('\n');
}

/**
 * Builds the `init --assist` AI resolver, or returns null to fall back to the
 * deterministic resolver. Runs the paid-call-free discovery, proposes the
 * sources (U4), applies the approved-endpoint policy (C5 OPT1) and the
 * `init.assist.provider` preference, lets the user choose, builds the chosen
 * backend, and composes `buildAiResolver` with the layer-4 egress-consent
 * (EV3/EV4) and merge-approval (EV2) prompts. Throws a DomainError (exit 3)
 * for OPT1 `fail` / UN2 unavailable; never returns when assist must hard-fail.
 */
async function buildAssistResolver(opts: {
  cwd: string;
  config: HarnessConfig;
  parsed: ParsedArgs;
  io: RunIO;
  prompt: Prompt;
  fallback: ContradictionResolver;
}): Promise<ContradictionResolver | null> {
  const { config, parsed, io, prompt, fallback, cwd } = opts;
  const assist = config.assist;
  const warn = (message: string): void => {
    io.stderr.write(`harness-haircut: ${message}\n`);
  };

  // Discover, then narrow to approved endpoints (C5 OPT1) and order by the
  // configured provider preference (pre-select only, never auto-run).
  const endpointPolicy = { policy: assist.endpointPolicy, approved: assist.approved };
  let sources = discoverCredentialSources(createDiscoveryProbes()).filter(
    (source) => checkEndpointPolicy(endpointPolicy, source.provider).allowed,
  );
  if (assist.provider !== null) {
    sources = [...sources].sort((a, b) => {
      const ap = a.provider === assist.provider ? 0 : 1;
      const bp = b.provider === assist.provider ? 0 : 1;
      return ap - bp;
    });
  }

  if (sources.length === 0) {
    if (assist.onUnavailable === 'fail') {
      throw new AssistBackendUnavailableError(
        '--assist found no usable AI credential source. Set a provider API key ' +
          '(e.g. ANTHROPIC_API_KEY / OPENAI_API_KEY / GEMINI_API_KEY) or log in to a ' +
          'provider CLI (claude / codex / gemini / copilot), or drop --assist.',
      );
    }
    warn('--assist found no AI credential source; using the deterministic resolver.');
    return null;
  }

  // Propose every discovered source with its caveat (U4/EV5); the user chooses.
  const remembered = readRememberedSource(assistStorePath());
  io.stdout.write('AI-assist credential sources discovered (choose one):\n');
  sources.forEach((source, index) => {
    const isRemembered =
      remembered !== null &&
      remembered.provider === source.provider &&
      remembered.kind === source.kind;
    io.stdout.write(
      `  ${index + 1}) ${source.provider} [${source.kind}]${isRemembered ? ' (remembered)' : ''}\n` +
        `       ${source.detail}\n` +
        `       caveat: ${source.caveat}\n`,
    );
  });
  const skipChoice = sources.length + 1;
  io.stdout.write(`  ${skipChoice}) none — use the deterministic resolver\n`);
  const answer = await prompt(`Choice [1-${skipChoice}]: `);
  const choice = Number.parseInt(answer, 10);
  if (!Number.isInteger(choice) || choice < 1 || choice >= skipChoice) {
    warn('no AI source selected; using the deterministic resolver.');
    return null;
  }
  const source = sources[choice - 1]!;

  const model =
    typeof parsed.flags['--assist-model'] === 'string'
      ? (parsed.flags['--assist-model'] as string)
      : assist.model;

  let backend: AssistBackend;
  try {
    backend = backendForSource(source, cwd, model);
  } catch (err) {
    if (err instanceof DomainError) {
      throw err; // UN2 — surfaced as exit 3 by the caller.
    }
    throw err;
  }

  // Remember the choice (kind + provider only) per-machine for next time.
  try {
    writeRememberedSource(assistStorePath(), { provider: source.provider, kind: source.kind });
  } catch {
    // Persistence is best-effort; a read-only home must not break --assist.
  }

  const egressFlags: EgressFlags = {
    include: parsed.repeated['--assist-include'] ?? [],
    optInPaths: [],
    allowSecretRules: parsed.repeated['--assist-allow-secret'] ?? [],
  };
  const assistYes = parsed.flags['--assist-yes'] === true;
  const showPreview = parsed.flags['--no-preview'] !== true;
  let consentRemembered = false;

  // EV3/EV4 — print the (non-suppressible) disclosure + optional preview, then
  // require an explicit affirmative. A run-level "yes" (or --assist-yes) skips
  // re-prompting but STILL prints the file list/counts/summary (UN2).
  const confirmEgress = async (plan: EgressPlan, destination: EgressDestination): Promise<boolean> => {
    io.stdout.write(renderEgressDisclosure(plan, destination));
    if (showPreview) {
      io.stdout.write(renderEgressPreview(plan));
    }
    if (assistYes || consentRemembered) {
      io.stdout.write('egress consent: pre-approved for this run.\n');
      return true;
    }
    const reply = await prompt(EGRESS_CONSENT_PROMPT);
    const yes = reply.toLowerCase() === 'y' || reply.toLowerCase() === 'yes';
    if (yes) {
      consentRemembered = true;
    }
    return yes;
  };

  // EV2 — show the proposed merge and require explicit approval; decline → fallback.
  const approveMerge = async (
    _slot: string,
    proposedText: string,
    candidates: readonly CandidateText[],
  ): Promise<boolean> => {
    io.stdout.write(`${renderMergeDiff(candidates, proposedText)}\n`);
    const reply = await prompt('Write this merged text? [y/N]: ');
    return reply.toLowerCase() === 'y' || reply.toLowerCase() === 'yes';
  };

  warn(
    `AI-assist enabled via ${source.provider} [${source.kind}]; ` +
      'every send is disclosed and every merge is human-approved.',
  );
  return buildAiResolver({ backend, egressFlags, confirmEgress, approveMerge, fallback, warn });
}

async function runInit(parsed: ParsedArgs, io: RunIO): Promise<ExitCode> {
  const cwdFlag = parsed.flags['--cwd'];
  const cwd = typeof cwdFlag === 'string' ? resolve(cwdFlag) : process.cwd();
  const configFlag =
    typeof parsed.flags['--config'] === 'string' ? (parsed.flags['--config'] as string) : undefined;
  const json = parsed.flags['--json'] === true;
  const dryRun = parsed.flags['--dry-run'] === true;
  const nonInteractive = parsed.flags['--non-interactive'] === true;
  const assistRequested = parsed.flags['--assist'] === true;
  // C6 (#44): adopt a hand-built `.agents/` tree as canonical (bypasses the
  // hand-canonical refusal only — see init's UN1; a tool-canonical repo is still
  // refused toward `apply`).
  const adopt = parsed.flags['--adopt'] === true;

  // #39: ONE EOF-safe, line-buffered stdin prompt for the whole run (created
  // lazily on the first prompt, closed once in `finally`), shared by the
  // several sequential `init --assist` prompts — source selection, egress
  // consent, merge approval, the deterministic fallback. See createStdinPrompt
  // for why rl.question could not be used here.
  const stdinPrompt = createStdinPrompt(process.stdin, io.stdout);
  const prompt: Prompt = stdinPrompt.prompt;

  let report: InitReport;
  try {
    const config = await readConfig(cwd, configFlag);
    const assistEnabled = assistRequested || config.assist.enabled;

    // OPT2 — `--assist` (or config-enabled assist) needs interaction (source
    // selection + merge approval), so it fails CLOSED under --non-interactive
    // rather than silently auto-selecting a source or auto-accepting a merge.
    if (assistEnabled && nonInteractive) {
      io.stderr.write(
        'harness-haircut: --assist cannot be combined with --non-interactive ' +
          '(credential selection and merge approval both require prompts).\n',
      );
      return 1;
    }

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

    // Resolver selection: --non-interactive uses the unresolved stub (the use
    // case fails first on any contradiction); assist (interactive) discovers,
    // proposes, and wires the AI resolver over a deterministic fallback;
    // otherwise the plain readline numbered-choice prompt.
    let resolveContradiction: ContradictionResolver;
    if (nonInteractive) {
      resolveContradiction = () => Promise.resolve<Resolution>({ kind: 'unresolved' });
    } else if (assistEnabled) {
      const fallback = readlineResolver(io, prompt);
      resolveContradiction =
        (await buildAssistResolver({ cwd, config, parsed, io, prompt, fallback })) ?? fallback;
    } else {
      resolveContradiction = readlineResolver(io, prompt);
    }

    report = await init({
      snapshot: () => readInitSnapshot(cwd, config.exclude),
      reader,
      writer,
      adapters,
      resolveContradiction,
      aliasOf: createSymlinkAliasProbe(cwd),
      // C3 reuses C2. init has just written canonical files, so the tree is
      // expected dirty during onboarding — apply runs with allowDirty so the
      // freshly-written canonical layout is projected. The init-level prompt
      // already resolved everything; apply finds only freshly-written
      // canonical files, so its own edited-file prompt should never fire, but
      // a non-interactive stub keeps it from blocking on a surprise.
      apply: () =>
        apply({
          parse: () => parseRepo({ readRepo: () => readRepoSnapshot(cwd, config.exclude) }),
          adapters,
          reader,
          writer,
          contextFor,
          isDirty: () => isWorkingTreeDirty(cwd),
          confirm: () => Promise.resolve(false),
          readState: (): ApplyState => parseState(reader.read(APPLY_STATE_PATH)),
          writeState: (state: ApplyState): void =>
            writer.write(APPLY_STATE_PATH, serializeState(state)),
          aliasOf: createSymlinkAliasProbe(cwd),
          // #40: init already reconciled pre-existing foreign files
          // interactively and backed up the non-chosen candidates, so the
          // chained apply legitimately claims the unmanaged originals it left in
          // place without re-prompting.
          flags: { allowDirty: true, dryRun, nonInteractive: true, claimUnmanaged: true },
        }),
      flags: { dryRun, nonInteractive, adopt },
    });
  } catch (err) {
    if (err instanceof DomainError) {
      io.stderr.write(`harness-haircut: ${err.message}\n`);
      return err.exitCode === 3 ? 3 : err.exitCode === 1 ? 1 : 70;
    }
    throw err;
  } finally {
    stdinPrompt.close();
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
    lines.push('refused — this repo is already managed by harness-haircut (run `harness-haircut apply` instead).');
    for (const note of report.notes) {
      lines.push(`  ${note}`);
    }
    lines.push('');
    return lines.join('\n');
  }

  if (report.refused === 'hand-canonical-needs-adopt') {
    lines.push('refused — this repo has a hand-built .agents/ layout (run `harness-haircut init --adopt` to adopt it).');
    for (const note of report.notes) {
      lines.push(`  ${note}`);
    }
    lines.push('');
    return lines.join('\n');
  }

  if (report.refused === 'symlinked-canonical-home') {
    lines.push('refused — .agents is a symlink, and init must own it as a real directory.');
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

  if (report.backups.length > 0) {
    const backupSet = new Set(report.backups);
    lines.push('');
    lines.push('preserved non-chosen candidates (originals backed up):');
    for (const contradiction of report.contradictions) {
      for (const candidate of contradiction.candidates) {
        const backupPath = `${INIT_BACKUP_DIR}/${sanitizeBackupName(candidate.path)}`;
        if (backupSet.has(backupPath)) {
          lines.push(`  ${contradiction.slot}: ${candidate.path} -> ${backupPath}`);
        }
      }
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
