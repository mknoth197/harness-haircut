/**
 * `doctor` use case — PRD §7 (`doctor` contract), layer 2. A read-only health
 * report: it prints the tool version, the Node version, the cwd, which
 * providers have existing config files in the repo, the parsed config, and any
 * environment warnings. Pure + DI: it performs NO I/O and touches no stdio /
 * process — the version, node version, cwd, the repo snapshot, and the raw
 * config text are all injected by the composition root (layer 4), which also
 * renders the report and maps the exit code.
 *
 * Detection reuses each adapter's `detectExisting` against the injected
 * snapshot — the same mechanism `init` uses — so "which providers are present"
 * stays a single source of truth.
 *
 * Exit codes (PRD §7): 0 normally; 3 when the config is invalid. An invalid
 * config does not throw — doctor's job is to DIAGNOSE, so it reports the
 * problem as a warning and a null config, and surfaces exit 3 so a script can
 * detect the bad config while still seeing the human-readable diagnosis.
 */
import type { ExistingProviderConfig, ProviderAdapter, RepoSnapshot } from '../entities/adapter.js';
import { DomainError } from '../entities/errors.js';
import { loadConfig } from './load-config.js';
import type { HarnessConfig } from './load-config.js';

export interface DoctorReport {
  /** The harness-haircut package version (injected from package.json). */
  version: string;
  /** The Node.js version the CLI is running on (e.g. `v24.15.0`). */
  nodeVersion: string;
  /** The repo root the report describes. */
  cwd: string;
  /** Providers with at least one existing config file, in adapter order. */
  detectedProviders: ExistingProviderConfig[];
  /** The parsed config, or `null` when the config file is invalid. */
  config: HarnessConfig | null;
  /** Human-readable environment/config warnings (e.g. an invalid config). */
  warnings: string[];
  /** PRD §7: 0 healthy · 3 invalid config. */
  exitCode: 0 | 3;
}

export interface DoctorDeps {
  /** The package version (read from package.json by layer 4). */
  version: string;
  /** `process.version` (injected so the use case stays pure). */
  nodeVersion: string;
  /** The repo root being diagnosed. */
  cwd: string;
  /** All provider adapters; `detectExisting` runs against the snapshot. */
  adapters: readonly ProviderAdapter[];
  /** Lazily reads the repo snapshot (wide init-style collection). */
  snapshot: () => Promise<RepoSnapshot>;
  /** Raw `harness-haircut.config.json` text, or `null` when the file is absent. */
  configRaw: string | null;
  /** The config path, used only for error messages. */
  configPath: string;
}

export async function doctor(deps: DoctorDeps): Promise<DoctorReport> {
  const snapshot = await deps.snapshot();

  const detectedProviders: ExistingProviderConfig[] = [];
  for (const adapter of deps.adapters) {
    const detected = adapter.detectExisting(snapshot);
    if (detected !== null) {
      detectedProviders.push(detected);
    }
  }

  const warnings: string[] = [];
  let config: HarnessConfig | null;
  let exitCode: 0 | 3 = 0;
  try {
    config = loadConfig(deps.configRaw, deps.configPath);
  } catch (err) {
    // Diagnose rather than crash: a bad config becomes a warning + null config,
    // and the exit code surfaces 3 so a script can still detect it (PRD §7).
    config = null;
    exitCode = 3;
    warnings.push(
      `invalid config: ${err instanceof DomainError ? err.message : String(err)}`,
    );
  }

  return {
    version: deps.version,
    nodeVersion: deps.nodeVersion,
    cwd: deps.cwd,
    detectedProviders,
    config,
    warnings,
    exitCode,
  };
}
