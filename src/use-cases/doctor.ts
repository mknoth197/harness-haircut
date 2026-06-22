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

/**
 * A discovered AI-assist credential source, reported by `doctor` for
 * visibility (C4 acceptance). Mirrors the gateway's `CredentialSource` shape
 * without importing layer 3 — the composition root runs the (paid-call-free)
 * discovery and passes the result in, so `doctor` stays a pure use case and
 * never makes a model call.
 */
export interface DoctorAssistSource {
  provider: string;
  kind: string;
  caveat: string;
  detail: string;
}

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
  /**
   * AI-assist credential sources discovered on this machine (C4) — empty when
   * none, or when assist discovery was not run. Reported, never acted on.
   */
  assistSources: DoctorAssistSource[];
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
  /**
   * Reads the repo snapshot (wide init-style collection), honoring the config
   * `exclude` globs. The use case derives `exclude` from its OWN single config
   * parse and passes it in — so layer 4 never re-parses the config just to
   * build the snapshot (the prior double-parse + swallowed error are gone).
   */
  snapshot: (exclude: readonly string[]) => Promise<RepoSnapshot>;
  /** Raw `harness-haircut.config.json` text, or `null` when the file is absent. */
  configRaw: string | null;
  /** The config path, used only for error messages. */
  configPath: string;
  /**
   * Set when an EXPLICIT `--config <path>` was passed but the file does not
   * exist. The default-location absence stays silent (it falls back to
   * defaults), but a health check should not quietly ignore a user pointing at
   * a config that is not there — doctor surfaces it as a warning.
   */
  explicitConfigMissing?: boolean;
  /**
   * AI-assist sources discovered by the composition root (paid-call-free); the
   * use case just reports them. Omitted → reported as empty (no discovery run).
   */
  assistSources?: DoctorAssistSource[];
}

export async function doctor(deps: DoctorDeps): Promise<DoctorReport> {
  const warnings: string[] = [];

  // A user-specified config that is not on disk is worth surfacing — the run
  // silently fell back to defaults, which is rarely what `--config <path>` was
  // meant to do. The default-location absence stays silent (handled by the
  // caller passing `explicitConfigMissing` only for an explicit path).
  if (deps.explicitConfigMissing === true) {
    warnings.push(`specified config not found: ${deps.configPath} (using defaults)`);
  }

  // Parse the config ONCE — the authoritative parse that drives both the
  // exit-3 diagnosis AND the snapshot's `exclude` list (so a fixture/excluded
  // path is not reported as a detected provider). No second best-effort parse
  // in layer 4.
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

  // An invalid config yields no exclude list (the report already flags it); the
  // snapshot then collects with no exclusions, the safe default.
  const snapshot = await deps.snapshot(config?.exclude ?? []);

  const detectedProviders: ExistingProviderConfig[] = [];
  for (const adapter of deps.adapters) {
    const detected = adapter.detectExisting(snapshot);
    if (detected !== null) {
      detectedProviders.push(detected);
    }
  }

  return {
    version: deps.version,
    nodeVersion: deps.nodeVersion,
    cwd: deps.cwd,
    detectedProviders,
    config,
    warnings,
    assistSources: deps.assistSources ?? [],
    exitCode,
  };
}
