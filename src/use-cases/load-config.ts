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
}

const ALL_PROVIDERS: readonly ProviderId[] = ['copilot', 'claude', 'codex', 'gemini'];

export function defaultConfig(): HarnessConfig {
  return {
    providers: null,
    providersDisabled: [],
    warningsAsErrors: false,
    writeGitignore: true,
    gemini: { mode: 'settings' },
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

  return config;
}

/**
 * The effective enabled provider set: the `providers` allow-list (or all
 * four when unset) minus `providers_disabled`, in canonical A-story order.
 */
export function enabledProviders(config: HarnessConfig): ProviderId[] {
  const base = config.providers ?? [...ALL_PROVIDERS];
  return base.filter((id) => !config.providersDisabled.includes(id));
}
