/**
 * Per-machine AI-assist credential-CHOICE persistence — C4 (#28) / PRD §17,
 * layer 3 (gateway).
 *
 * A remembered choice records ONLY the *source kind + provider* the developer
 * picked — never a credential value — and lives **user-local and gitignored**,
 * NOT in the team-shared `harness-haircut.config.json`: credentials and CLI
 * sessions are per-developer, so a committed choice would be wrong (or leak
 * intent) for teammates. Default location follows `XDG_CONFIG_HOME`
 * (`~/.config/harness-haircut/assist.json`); the base dir is injectable so
 * tests stay off the real home directory.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import type { ProviderId } from '../entities/adapter.js';
import type { CredentialKind } from './ai-credentials.js';

/** The remembered selection — kind + provider only, never a secret. */
export interface RememberedSource {
  provider: ProviderId;
  kind: CredentialKind;
}

const ALL_PROVIDERS: readonly ProviderId[] = ['copilot', 'claude', 'codex', 'gemini'];
const ALL_KINDS: readonly CredentialKind[] = ['api-key', 'subscription-session'];

/** Resolves the user-local store path (honors `XDG_CONFIG_HOME`). */
export function assistStorePath(env: NodeJS.ProcessEnv = process.env): string {
  const base = env['XDG_CONFIG_HOME'];
  const root = base !== undefined && base !== '' ? base : join(homedir(), '.config');
  return join(root, 'harness-haircut', 'assist.json');
}

/**
 * Reads the remembered source, or null when none/invalid. Never throws —
 * a missing or corrupt store just means "no remembered choice".
 */
export function readRememberedSource(path: string): RememberedSource | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (parsed === null || typeof parsed !== 'object') {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  const provider = obj['provider'];
  const kind = obj['kind'];
  if (
    typeof provider === 'string' &&
    (ALL_PROVIDERS as readonly string[]).includes(provider) &&
    typeof kind === 'string' &&
    (ALL_KINDS as readonly string[]).includes(kind)
  ) {
    return { provider: provider as ProviderId, kind: kind as CredentialKind };
  }
  return null;
}

/**
 * Persists the chosen source (kind + provider only) to the user-local store,
 * creating the directory if needed. Writes nothing but those two fields, so a
 * credential value can never land here.
 */
export function writeRememberedSource(path: string, source: RememberedSource): void {
  mkdirSync(dirname(path), { recursive: true });
  const payload = JSON.stringify({ provider: source.provider, kind: source.kind }, null, 2);
  writeFileSync(path, `${payload}\n`, { encoding: 'utf8', mode: 0o600 });
}
