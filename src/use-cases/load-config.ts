/**
 * `harness-haircut.config.json` loader — C1 (#11), layer 2.
 *
 * Pure: it parses a raw config *string* (or `null` when the file is absent)
 * into a validated `HarnessConfig`. The composition root (layer 4) reads the
 * file from disk and hands the text in — no I/O happens here, matching the
 * use-case layer rules. A malformed or invalid config throws
 * `InvalidConfigError` (exit code 3, C1 UN). An absent config yields sane
 * defaults: all four providers enabled, Gemini in `settings` mode,
 * warnings not treated as errors (PRD §8 schema).
 */
import type { ProviderId } from '../entities/adapter.js';
import { InvalidConfigError } from '../entities/errors.js';

export type GeminiMode = 'settings' | 'shim';

/** OPT1 behavior when `init --assist` discovers no usable credential source. */
export type AssistOnUnavailable = 'fallback' | 'fail';

/** C5 OPT1 endpoint posture; `approved-only` is recommended for corp installs. */
export type AssistEndpointPolicy = 'any' | 'approved-only';

/**
 * C4 (#28) / PRD §17 AI-assist policy — team-shared, NON-secret knobs only.
 * The per-developer credential CHOICE is never stored here (it lives in a
 * gitignored, user-local file). All fields have safe defaults so omitting the
 * `init.assist` block leaves assist OFF.
 */
export interface AssistConfig {
  /** Whether `init` may use the AI resolver without the `--assist` flag. */
  enabled: boolean;
  /** OPT1: on no discovered source, fall back to deterministic (default) or fail. */
  onUnavailable: AssistOnUnavailable;
  /** C5 OPT1: restrict egress to an approved provider/endpoint allowlist. */
  endpointPolicy: AssistEndpointPolicy;
  /** Approved provider ids when `endpointPolicy === 'approved-only'`. */
  approved: ProviderId[];
  /** Optional preferred provider — pre-selects in discovery, never overrides it. */
  provider: ProviderId | null;
  /** Optional model override (else CLI-default for session / balanced-tier for SDK). */
  model: string | null;
}

export interface HarnessConfig {
  /** Providers explicitly listed as enabled; `null` means "all four". */
  providers: ProviderId[] | null;
  /** Providers to skip entirely (subtracted from the enabled set). */
  providersDisabled: ProviderId[];
  /** When true, any `warn` severity is escalated to a failure (PRD §11). */
  warningsAsErrors: boolean;
  /** Reserved for C2 (`apply`); parsed here so the schema validates whole. */
  writeGitignore: boolean;
  gemini: { mode: GeminiMode };
  /** C4 AI-assist policy (PRD §17); defaults leave assist disabled. */
  assist: AssistConfig;
}

const ALL_PROVIDERS: readonly ProviderId[] = ['copilot', 'claude', 'codex', 'gemini'];

export function defaultAssistConfig(): AssistConfig {
  return {
    enabled: false,
    onUnavailable: 'fallback',
    endpointPolicy: 'any',
    approved: [],
    provider: null,
    model: null,
  };
}

export function defaultConfig(): HarnessConfig {
  return {
    providers: null,
    providersDisabled: [],
    warningsAsErrors: false,
    writeGitignore: true,
    gemini: { mode: 'settings' },
    assist: defaultAssistConfig(),
  };
}

function isProviderId(value: unknown): value is ProviderId {
  return typeof value === 'string' && (ALL_PROVIDERS as readonly string[]).includes(value);
}

function readProviderArray(
  value: unknown,
  key: string,
  path: string,
): ProviderId[] {
  if (!Array.isArray(value)) {
    throw new InvalidConfigError(path, `"${key}" must be an array of provider ids`);
  }
  for (const entry of value) {
    if (!isProviderId(entry)) {
      throw new InvalidConfigError(
        path,
        `"${key}" contains an unknown provider ${JSON.stringify(entry)}; ` +
          `valid providers: ${ALL_PROVIDERS.join(', ')}`,
      );
    }
  }
  return value as ProviderId[];
}

function readBoolean(value: unknown, key: string, path: string, fallback: boolean): boolean {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== 'boolean') {
    throw new InvalidConfigError(path, `"${key}" must be a boolean`);
  }
  return value;
}

/**
 * Validates parsed config and returns a `HarnessConfig`. `raw` is the file
 * text, or `null` when no config file exists (defaults apply). `path` is
 * used only for error messages.
 */
export function loadConfig(raw: string | null, path = 'harness-haircut.config.json'): HarnessConfig {
  if (raw === null) {
    return defaultConfig();
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new InvalidConfigError(
      path,
      `malformed JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new InvalidConfigError(path, 'top-level value must be a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  const config = defaultConfig();

  if (obj['providers'] !== undefined) {
    config.providers = readProviderArray(obj['providers'], 'providers', path);
  }
  if (obj['providers_disabled'] !== undefined) {
    config.providersDisabled = readProviderArray(
      obj['providers_disabled'],
      'providers_disabled',
      path,
    );
  }
  config.warningsAsErrors = readBoolean(
    obj['warningsAsErrors'],
    'warningsAsErrors',
    path,
    config.warningsAsErrors,
  );
  config.writeGitignore = readBoolean(
    obj['writeGitignore'],
    'writeGitignore',
    path,
    config.writeGitignore,
  );

  const gemini = obj['gemini'];
  if (gemini !== undefined) {
    if (gemini === null || typeof gemini !== 'object' || Array.isArray(gemini)) {
      throw new InvalidConfigError(path, '"gemini" must be an object');
    }
    const mode = (gemini as Record<string, unknown>)['mode'];
    if (mode !== undefined) {
      if (mode !== 'settings' && mode !== 'shim') {
        throw new InvalidConfigError(
          path,
          `"gemini.mode" must be "settings" or "shim", got ${JSON.stringify(mode)}`,
        );
      }
      config.gemini.mode = mode;
    }
  }

  // C4 AI-assist policy: `init.assist` may be `true` (enable with defaults) or
  // an object of non-secret knobs. The per-developer credential CHOICE is
  // never read from here — only team-shareable policy.
  const init = obj['init'];
  if (init !== undefined) {
    if (init === null || typeof init !== 'object' || Array.isArray(init)) {
      throw new InvalidConfigError(path, '"init" must be an object');
    }
    config.assist = readAssistConfig((init as Record<string, unknown>)['assist'], path);
  }

  return config;
}

function readAssistConfig(value: unknown, path: string): AssistConfig {
  const assist = defaultAssistConfig();
  if (value === undefined) {
    return assist;
  }
  // Shorthand: `"assist": true` enables with all defaults.
  if (typeof value === 'boolean') {
    assist.enabled = value;
    return assist;
  }
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new InvalidConfigError(path, '"init.assist" must be a boolean or an object');
  }
  const obj = value as Record<string, unknown>;
  assist.enabled = readBoolean(obj['enabled'], 'init.assist.enabled', path, assist.enabled);

  const onUnavailable = obj['onUnavailable'];
  if (onUnavailable !== undefined) {
    if (onUnavailable !== 'fallback' && onUnavailable !== 'fail') {
      throw new InvalidConfigError(
        path,
        `"init.assist.onUnavailable" must be "fallback" or "fail", got ${JSON.stringify(onUnavailable)}`,
      );
    }
    assist.onUnavailable = onUnavailable;
  }

  const endpointPolicy = obj['endpointPolicy'];
  if (endpointPolicy !== undefined) {
    if (endpointPolicy !== 'any' && endpointPolicy !== 'approved-only') {
      throw new InvalidConfigError(
        path,
        `"init.assist.endpointPolicy" must be "any" or "approved-only", got ${JSON.stringify(endpointPolicy)}`,
      );
    }
    assist.endpointPolicy = endpointPolicy;
  }

  if (obj['approved'] !== undefined) {
    assist.approved = readProviderArray(obj['approved'], 'init.assist.approved', path);
  }

  const provider = obj['provider'];
  if (provider !== undefined && provider !== null) {
    if (!isProviderId(provider)) {
      throw new InvalidConfigError(
        path,
        `"init.assist.provider" must be a provider id (${ALL_PROVIDERS.join(', ')}), got ${JSON.stringify(provider)}`,
      );
    }
    assist.provider = provider;
  }

  const model = obj['model'];
  if (model !== undefined && model !== null) {
    if (typeof model !== 'string' || model === '') {
      throw new InvalidConfigError(path, '"init.assist.model" must be a non-empty string');
    }
    assist.model = model;
  }

  return assist;
}

/**
 * The effective enabled provider set: the `providers` allow-list (or all
 * four when unset) minus `providers_disabled`, in canonical A-story order.
 */
export function enabledProviders(config: HarnessConfig): ProviderId[] {
  const base = config.providers ?? [...ALL_PROVIDERS];
  return base.filter((id) => !config.providersDisabled.includes(id));
}
