/**
 * AI-assist credential DISCOVERY — C4 (#28) U4, layer 3 (gateway).
 *
 * `init --assist` never assumes a provider: it runs a **paid-call-free**
 * discovery that probes, per provider, (a) the CLI binary on PATH, (b) an env
 * API key, and (c) an authenticated subscription session (a session
 * file/keychain marker), then PROPOSES every source it finds for the user to
 * choose (PRD §17, the provider matrix's "AI-assist credential sources"
 * section). NO model call is ever made here, and NO source is auto-selected.
 *
 * Purity boundary: the ranking + caveat logic is a pure function of an
 * injected `DiscoveryProbes` (so tests run fully offline). Only
 * `createDiscoveryProbes` touches the real world (env, PATH walk, file/keychain
 * presence). It NEVER execs a PATH-resolved provider binary (that would give a
 * PATH-shadowing untrusted repo code execution from `doctor`); the only process
 * it spawns is the ABSOLUTE `/usr/bin/security` (macOS keychain presence), in a
 * neutral cwd with a minimal env. The deterministic core (`audit`/`apply`/CI/
 * hooks) never imports this module; only `init --assist` and `doctor` do.
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import type { ProviderId } from '../entities/adapter.js';

export type CredentialKind = 'api-key' | 'subscription-session';

/** One discovered, selectable credential source (never carries a secret value). */
export interface CredentialSource {
  provider: ProviderId;
  kind: CredentialKind;
  /**
   * Proposal-ordering rank (lower = preferred). Per the matrix: an explicit
   * env API key (deterministic, CI-safe, billed-as-expected) ranks above an
   * authed subscription session (ToS/metering caveats). Used only for display
   * order — the user still chooses; nothing auto-runs.
   */
  rank: number;
  /** ToS/feasibility caveat surfaced at selection time (EV5). */
  caveat: string;
  /** How it was detected — for the disclosure/doctor (e.g. `env ANTHROPIC_API_KEY`). Never a value. */
  detail: string;
}

/**
 * Injected probes — the only world-touching surface. Tests supply a fake so
 * discovery runs offline; `createDiscoveryProbes` supplies the real ones.
 */
export interface DiscoveryProbes {
  /** Is the named CLI binary resolvable on PATH? */
  hasBinary: (binary: string) => boolean;
  /** Value of an env var, or undefined when unset/empty. */
  getEnv: (name: string) => string | undefined;
  /**
   * Detect an authenticated subscription session WITHOUT a paid call. Returns
   * a short detail string (e.g. `~/.codex/auth.json present`) when a session
   * is found, or null. Exec-free except the absolute-path macOS keychain probe.
   */
  detectSession: (provider: ProviderId) => string | null;
}

/** Per-provider discovery facts, sourced from docs/research/provider-matrix.md. */
interface ProviderProbe {
  provider: ProviderId;
  binary: string;
  /** Env var names that hold an API key, in precedence order. */
  apiKeyEnv: readonly string[];
  apiKeyCaveat: string;
  sessionCaveat: string;
  /** Provider tie-break order within a rank tier (stable, deterministic). */
  order: number;
}

const PROVIDER_PROBES: readonly ProviderProbe[] = [
  {
    provider: 'claude',
    binary: 'claude',
    apiKeyEnv: ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN'],
    apiKeyCaveat:
      'sends file contents to the Anthropic API under your key (billed as usual).',
    sessionCaveat:
      'reuses your logged-in Claude subscription via `claude -p` — sanctioned for ' +
      'scripted use (Anthropic Agent SDK credit, eff. 2026-06-15).',
    order: 0,
  },
  {
    provider: 'codex',
    binary: 'codex',
    apiKeyEnv: ['OPENAI_API_KEY'],
    apiKeyCaveat: 'sends file contents to the OpenAI API under your key (billed as usual).',
    sessionCaveat:
      'reuses your ChatGPT session via `codex exec` — works, but OpenAI prefers API ' +
      'keys for automation and calls meter against your plan limits.',
    order: 1,
  },
  {
    provider: 'gemini',
    binary: 'gemini',
    apiKeyEnv: ['GEMINI_API_KEY', 'GOOGLE_API_KEY'],
    apiKeyCaveat: 'sends file contents to the Gemini API under your key (billed as usual).',
    sessionCaveat:
      'reuses your Google AI subscription via `gemini -p` — headless OAuth caching is ' +
      'flaky, Google steers automation to service accounts, and consumer auth sunsets 2026-06-18.',
    order: 2,
  },
  {
    provider: 'copilot',
    binary: 'copilot',
    apiKeyEnv: ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'],
    apiKeyCaveat:
      'uses your GitHub token via `copilot -p` (text-only output; consumes premium requests).',
    sessionCaveat:
      'reuses your Copilot seat via `copilot -p` — subscription-only, text-only (no JSON), ' +
      'and every call consumes a premium request.',
    order: 3,
  },
];

/**
 * Pure discovery: given the probe results, returns every available source,
 * ranked for proposal order (api-key tier before subscription-session tier,
 * provider order as the tie-break). An env API key implies the SDK backend; a
 * session marker implies the CLI-headless backend. A provider with neither
 * yields no source. Nothing is auto-selected.
 */
export function discoverCredentialSources(probes: DiscoveryProbes): CredentialSource[] {
  const sources: CredentialSource[] = [];
  for (const probe of PROVIDER_PROBES) {
    const hasBinary = probes.hasBinary(probe.binary);
    // api-key source: an env key is usable via the SDK even with no binary.
    const envName = probe.apiKeyEnv.find((name) => {
      const value = probes.getEnv(name);
      return value !== undefined && value !== '';
    });
    if (envName !== undefined) {
      sources.push({
        provider: probe.provider,
        kind: 'api-key',
        rank: 0 * 10 + probe.order,
        caveat: probe.apiKeyCaveat,
        detail: `env ${envName}`,
      });
    }
    // subscription-session source: requires the CLI binary AND a session marker.
    if (hasBinary) {
      const sessionDetail = probes.detectSession(probe.provider);
      if (sessionDetail !== null) {
        sources.push({
          provider: probe.provider,
          kind: 'subscription-session',
          rank: 1 * 10 + probe.order,
          caveat: probe.sessionCaveat,
          detail: `${probe.binary} on PATH + ${sessionDetail}`,
        });
      }
    }
  }
  return sources.sort((a, b) => a.rank - b.rank);
}

/** True when `binary` resolves on PATH (no execution — a pure PATH walk). */
function binaryOnPath(binary: string): boolean {
  const paths = (process.env['PATH'] ?? '').split(platform() === 'win32' ? ';' : ':');
  const exts = platform() === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const dir of paths) {
    if (dir === '') {
      continue;
    }
    for (const ext of exts) {
      if (existsSync(join(dir, binary + ext))) {
        return true;
      }
    }
  }
  return false;
}

/** Authed-session markers per provider — file/keychain presence, or a status probe. */
function detectRealSession(provider: ProviderId): string | null {
  const home = homedir();
  switch (provider) {
    case 'claude': {
      const credFile = join(home, '.claude', '.credentials.json');
      if (existsSync(credFile)) {
        return '~/.claude/.credentials.json present';
      }
      // macOS stores it in the Keychain; presence is checked without reading.
      if (platform() === 'darwin' && keychainHas('Claude Code-credentials')) {
        return 'macOS Keychain "Claude Code-credentials" present';
      }
      return null;
    }
    case 'codex': {
      // SECURITY: we deliberately do NOT exec `codex login status` here. `codex`
      // is a PATH-resolved bare name; running it during discovery (which `doctor`
      // also reaches, in an untrusted repo) would give a PATH-shadowing binary
      // arbitrary code execution with the inherited cwd/env — bypassing every
      // isolation the completion path applies. The auth-file presence is an
      // exec-free marker that detects the same session.
      if (existsSync(join(home, '.codex', 'auth.json'))) {
        return '~/.codex/auth.json present';
      }
      return null;
    }
    case 'gemini': {
      if (existsSync(join(home, '.gemini', 'oauth_creds.json'))) {
        return '~/.gemini/oauth_creds.json present';
      }
      return null;
    }
    case 'copilot': {
      if (existsSync(join(home, '.copilot', 'config.json'))) {
        return '~/.copilot/config.json present';
      }
      if (platform() === 'darwin' && keychainHas('copilot-cli')) {
        return 'macOS Keychain "copilot-cli" present';
      }
      return null;
    }
    default:
      return null;
  }
}

/**
 * macOS Keychain presence check — never reads the secret, only its existence.
 * Uses the ABSOLUTE `/usr/bin/security` (so a PATH-shadowing repo binary can
 * never be run in its place) in a neutral cwd with a minimal env (no inherited
 * secrets/behavior vars). Only ever called on darwin.
 */
function keychainHas(service: string): boolean {
  try {
    execFileSync('/usr/bin/security', ['find-generic-password', '-s', service], {
      stdio: 'ignore',
      timeout: 3000,
      cwd: homedir(),
      env: { HOME: homedir(), PATH: '/usr/bin:/bin' },
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Real probes for the composition root. The only world-touching surface;
 * everything it does is paid-call-free and exec-free except the absolute
 * `/usr/bin/security` keychain-presence probe (a PATH walk, env reads, and
 * file-presence checks otherwise).
 */
export function createDiscoveryProbes(): DiscoveryProbes {
  return {
    hasBinary: binaryOnPath,
    getEnv: (name) => {
      const value = process.env[name];
      return value !== undefined && value !== '' ? value : undefined;
    },
    detectSession: detectRealSession,
  };
}
