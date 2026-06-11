/**
 * AI-assist BACKENDS — C4 (#28) U2/U5/EV5 + threat-model Finding 1, layer 3.
 *
 * Two implementations of `AssistBackend` (the only model-talking surface):
 *
 *   - SDK backend (`createSdkBackend`): an Env-API-key source. The provider
 *     SDK is an OPTIONAL/peer dependency loaded via a lazy, injected
 *     `import()` ONLY here — never statically, never on the deterministic
 *     path. Absent SDK → UN2 (exit 3) with an actionable message.
 *   - CLI-headless backend (`createCliBackend`): a subscription-session
 *     source. Spawns the provider CLI via an injected `execFile`-style
 *     `spawn`, with the Finding-1 mitigations baked in and asserted:
 *       • cwd is a FRESH EMPTY SCRATCH DIR, never the repo (so the CLI cannot
 *         auto-discover the repo's CLAUDE.md/AGENTS.md/GEMINI.md, .claude
 *         skills, or .mcp.json);
 *       • the provider's "ignore project config" flag is passed where one
 *         exists (`claude --strict-mcp-config`, `codex exec --cd <scratch>
 *         --skip-git-repo-check`, `copilot --no-custom-instructions`);
 *       • a curated, behavior-stripped env (PATH/HOME/USER/LANG + the
 *         provider's own auth vars only);
 *       • content travels via the prompt/stdin, never by pointing the CLI at
 *         the repo; and a bounded timeout.
 *
 * Both spawn/import surfaces are injected so tests assert the isolation and
 * the lazy-import/UN2 behavior with NO real process and NO real network.
 */
import type { ProviderId } from '../entities/adapter.js';
import { DomainError } from '../entities/errors.js';
import type { EgressDestination } from '../entities/index.js';
import type { AssistBackend, AssistProposal, AssistRequest } from './ai-resolver.js';

/** UN2: a chosen source's backend isn't installed/available → exit 3, not a crash. */
export class AssistBackendUnavailableError extends DomainError {
  constructor(message: string) {
    super(message, 3);
    this.name = 'AssistBackendUnavailableError';
  }
}

/** Bounded single-call timeout for a CLI/SDK assist invocation. */
const ASSIST_TIMEOUT_MS = 120_000;

/**
 * Balanced mid-tier default model per provider for the SDK backend (PRD §17:
 * favor a fast balanced tier, never pin a flagship; trivially bumpable). The
 * CLI/session backend passes NO `--model` and uses the CLI's own default.
 */
const SDK_DEFAULT_MODEL: Record<ProviderId, string> = {
  claude: 'claude-sonnet-4-6',
  codex: 'gpt-5.1',
  gemini: 'gemini-2.5-flash',
  copilot: 'gpt-5.1', // copilot has no SDK; present for type completeness only.
};

const RETENTION_CAVEAT =
  'file contents are sent to a third-party model provider and may be retained ' +
  'per that vendor’s terms; treat this as publishing to an external service.';

/**
 * The judge/merge instruction. The model receives only the C5-cleared,
 * post-redaction candidate texts and must answer in a strict JSON shape so the
 * response parses deterministically. A human reviews any merge before it is
 * written (EV2), so the prompt optimizes for a faithful union, not authority.
 */
export function buildAssistPrompt(request: AssistRequest): string {
  const lines: string[] = [];
  lines.push(
    'You are reconciling AI-assistant instruction texts during a one-time, ' +
      'human-supervised onboarding. Several provider config files contributed a ' +
      'candidate for the same logical slot. Decide whether they are SEMANTICALLY ' +
      'EQUIVALENT (same meaning, different wording) or genuinely differ.',
  );
  lines.push('');
  lines.push(`Slot: ${request.slot}`);
  lines.push('');
  request.candidates.forEach((candidate, index) => {
    lines.push(`--- Candidate ${index + 1} (${candidate.providerId}: ${candidate.path}) ---`);
    lines.push(candidate.text);
    lines.push('');
  });
  lines.push(
    'Reply with ONLY a JSON object, no prose, no code fence. If the candidates ' +
      'are semantically equivalent, reply {"equivalent": true}. Otherwise reply ' +
      '{"equivalent": false, "merged": "<a single merged canonical markdown text ' +
      'that preserves every distinct instruction from all candidates, losing ' +
      'nothing>"}.',
  );
  return lines.join('\n');
}

/**
 * Parses a backend's raw text into an `AssistProposal`. Tolerates a leading/
 * trailing code fence or surrounding prose by extracting the first balanced
 * JSON object. Throws on unparseable/missing output — the resolver treats a
 * throw as UN1 (deterministic fallback), so a confused model never silently
 * becomes a (non-)merge.
 */
export function parseAssistResponse(raw: string): AssistProposal {
  const json = extractJsonObject(raw);
  if (json === null) {
    throw new Error('assist backend returned no parseable JSON object');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(`assist backend returned invalid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new Error('assist backend JSON was not an object');
  }
  const obj = parsed as Record<string, unknown>;
  if (obj['equivalent'] === true) {
    return { kind: 'equivalent' };
  }
  const merged = obj['merged'];
  if (typeof merged === 'string' && merged.trim() !== '') {
    return { kind: 'merge', text: merged };
  }
  throw new Error('assist backend JSON had neither equivalent:true nor a non-empty merged text');
}

/** Extracts the first balanced top-level `{...}` from text (fence/prose tolerant). */
function extractJsonObject(raw: string): string | null {
  const start = raw.indexOf('{');
  if (start === -1) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < raw.length; i++) {
    const ch = raw[i]!;
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return raw.slice(start, i + 1);
      }
    }
  }
  return null;
}

/** Injected spawn surface — a single bounded, non-interactive CLI invocation. */
export interface CliSpawnRequest {
  binary: string;
  args: readonly string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Prompt delivered on stdin (content never reaches argv/the filesystem). */
  input: string;
  timeoutMs: number;
}
export interface CliSpawnResult {
  stdout: string;
  /** 0 on success; non-zero (or a spawn failure mapped to non-zero) otherwise. */
  exitCode: number;
  /** Captured for diagnostics (e.g. not-logged-in / over-quota). */
  stderr: string;
}
export type CliSpawn = (request: CliSpawnRequest) => Promise<CliSpawnResult>;

/** Per-provider headless invocation, encoding the Finding-1 isolation flags. */
interface CliInvocation {
  binary: string;
  args: string[];
}

/**
 * Builds the isolated CLI invocation. cwd is supplied by the caller (always a
 * scratch dir); these args carry the provider's ignore-project-config flag and
 * a structured-output flag where the CLI supports one. The prompt goes on
 * stdin, so it never appears in argv or on disk. `scratchDir` is passed for
 * providers that pin their working root via a flag (codex `--cd`) rather than
 * relying on the process cwd alone — defense-in-depth for Finding 1.
 */
export function cliInvocation(
  provider: ProviderId,
  model: string | null,
  scratchDir?: string,
): CliInvocation {
  switch (provider) {
    case 'claude':
      // `-p` reads the prompt from stdin; `--strict-mcp-config` (with no
      // --mcp-config) loads no MCP servers; the scratch cwd means no CLAUDE.md
      // / .claude settings / skills are auto-discovered from the repo.
      return {
        binary: 'claude',
        args: [
          '-p',
          '--output-format',
          'json',
          '--strict-mcp-config',
          ...(model !== null ? ['--model', model] : []),
        ],
      };
    case 'codex':
      // `--cd <scratch>` pins the working root to the scratch dir (so codex
      // cannot auto-load the repo's AGENTS.md even if its default working root
      // ever diverged from the process cwd); `--skip-git-repo-check` lets it
      // run outside a repo; `--json` emits structured events. The caller also
      // sets cwd === scratch.
      return {
        binary: 'codex',
        args: [
          'exec',
          ...(scratchDir !== undefined ? ['--cd', scratchDir] : []),
          '--skip-git-repo-check',
          '--json',
          ...(model !== null ? ['-m', model] : []),
          '-',
        ],
      };
    case 'gemini':
      return {
        binary: 'gemini',
        args: ['-p', '--output-format', 'json', ...(model !== null ? ['-m', model] : [])],
      };
    case 'copilot':
      // Copilot is text-only (no JSON). `--no-custom-instructions` disables
      // loading AGENTS.md and related files; the scratch cwd isolates the rest.
      return {
        binary: 'copilot',
        args: ['-p', '-s', '--no-custom-instructions', ...(model !== null ? ['--model', model] : [])],
      };
    default:
      throw new AssistBackendUnavailableError(`no CLI-headless backend for provider "${provider}"`);
  }
}

/**
 * Curated env for a CLI spawn: only PATH/HOME/USER/LANG (so the CLI can find
 * its binary and its own session creds in HOME/keychain) — every other
 * variable, including behavior-changing ones the untrusted repo's env or the
 * parent process might carry, is dropped.
 */
export function curatedEnv(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of ['PATH', 'HOME', 'USER', 'LANG', 'LC_ALL', 'TMPDIR']) {
    const value = source[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

export interface CliBackendConfig {
  provider: ProviderId;
  model: string | null;
  /** Repo root — used ONLY to assert the scratch cwd is never under it. */
  repoRoot: string;
  /** Creates a fresh empty scratch directory and returns its absolute path. */
  makeScratchDir: () => string;
  /** Injected spawn (default: real execFile); tests pass a recorder. */
  spawn: CliSpawn;
  /** Source env to curate (default: process.env). */
  env?: NodeJS.ProcessEnv;
}

/**
 * Builds the CLI-headless (subscription-session) backend. Each call spawns the
 * provider CLI in a fresh scratch dir with the isolation flags above. The
 * scratch dir being outside the repo is asserted at call time — a
 * misconfiguration fails closed (throws) rather than spawning inside the repo.
 */
export function createCliBackend(config: CliBackendConfig): AssistBackend {
  const destination: EgressDestination = {
    provider: config.provider,
    model: config.model ?? '(CLI default)',
    sourceKind: 'subscription-session',
    retentionCaveat: RETENTION_CAVEAT,
  };
  return {
    destination,
    proposeResolution: async (request: AssistRequest): Promise<AssistProposal> => {
      const scratch = config.makeScratchDir();
      const normalizedRoot = config.repoRoot.replace(/\/+$/, '');
      if (scratch === normalizedRoot || scratch.startsWith(`${normalizedRoot}/`)) {
        // Fail closed: never run the provider CLI inside the repo (Finding 1).
        throw new Error(
          `refusing to spawn the assist CLI inside the repo (scratch=${scratch}, repo=${normalizedRoot})`,
        );
      }
      const { binary, args } = cliInvocation(config.provider, config.model, scratch);
      const result = await config.spawn({
        binary,
        args,
        cwd: scratch,
        env: curatedEnv(config.env ?? process.env),
        input: buildAssistPrompt(request),
        timeoutMs: ASSIST_TIMEOUT_MS,
      });
      if (result.exitCode !== 0) {
        throw new Error(
          `${binary} exited ${result.exitCode}` +
            (result.stderr.trim() !== '' ? `: ${result.stderr.trim().slice(0, 200)}` : ''),
        );
      }
      return parseAssistResponse(extractCliText(config.provider, result.stdout));
    },
  };
}

/**
 * Pulls the model's final text out of a CLI's stdout. Claude/Gemini wrap it in
 * a JSON envelope (`{ result }` / candidates); Codex emits JSONL events;
 * Copilot prints the text directly. We then run `parseAssistResponse` on the
 * extracted text. Best-effort and tolerant — a wrong shape becomes a parse
 * error → UN1 fallback, never a bad write.
 */
function extractCliText(provider: ProviderId, stdout: string): string {
  if (provider === 'copilot') {
    return stdout;
  }
  if (provider === 'codex') {
    // JSONL: find the last event carrying an assistant message / final text.
    const texts: string[] = [];
    for (const line of stdout.split('\n')) {
      const trimmed = line.trim();
      if (trimmed === '' || trimmed[0] !== '{') {
        continue;
      }
      try {
        const event = JSON.parse(trimmed) as Record<string, unknown>;
        const msg = event['msg'] ?? event;
        const text =
          (msg as Record<string, unknown>)['text'] ??
          (msg as Record<string, unknown>)['message'] ??
          (msg as Record<string, unknown>)['last_agent_message'];
        if (typeof text === 'string') {
          texts.push(text);
        }
      } catch {
        // ignore non-JSON lines
      }
    }
    return texts.length > 0 ? texts[texts.length - 1]! : stdout;
  }
  // claude / gemini: a single JSON envelope around the text.
  try {
    const env = JSON.parse(stdout) as Record<string, unknown>;
    const result = env['result'] ?? env['response'] ?? env['text'];
    if (typeof result === 'string') {
      return result;
    }
  } catch {
    // not an envelope — fall through to the raw text.
  }
  return stdout;
}

/** Injected lazy SDK loader: `(moduleName) => import(moduleName)`. */
export type SdkLoader = (moduleName: string) => Promise<unknown>;

/** Provider → npm SDK module name (optional/peer dependency). */
const SDK_MODULE: Partial<Record<ProviderId, string>> = {
  claude: '@anthropic-ai/sdk',
  codex: 'openai',
  gemini: '@google/generative-ai',
  // copilot: no SDK — subscription/CLI only.
};

export interface SdkBackendConfig {
  provider: ProviderId;
  model: string | null;
  /** The env API key value (read by the composition root from the chosen env var). */
  apiKey: string;
  /** Injected module loader (default: native dynamic import). */
  load: SdkLoader;
}

/**
 * Builds the Env-API-key (SDK) backend. The provider SDK is `import()`-ed
 * lazily through `config.load` ONLY when this backend actually runs; an absent
 * optional dependency surfaces as `AssistBackendUnavailableError` (exit 3, UN2)
 * with an install hint, never a crash. The SDK call itself is provider-shaped
 * and runs only with the user's key + the human reviewing the result.
 */
export function createSdkBackend(config: SdkBackendConfig): AssistBackend {
  const moduleName = SDK_MODULE[config.provider];
  const model = config.model ?? SDK_DEFAULT_MODEL[config.provider];
  const destination: EgressDestination = {
    provider: config.provider,
    model,
    sourceKind: 'api-key',
    retentionCaveat: RETENTION_CAVEAT,
  };
  return {
    destination,
    proposeResolution: async (request: AssistRequest): Promise<AssistProposal> => {
      if (moduleName === undefined) {
        throw new AssistBackendUnavailableError(
          `provider "${config.provider}" has no API-key SDK backend; use its subscription-session CLI instead.`,
        );
      }
      let sdk: unknown;
      try {
        sdk = await config.load(moduleName);
      } catch {
        throw new AssistBackendUnavailableError(
          `the optional "${moduleName}" SDK is not installed. Run \`npm i -D ${moduleName}\` to use the ${config.provider} API-key assist backend, or pick a subscription-session source.`,
        );
      }
      const raw = await callSdk(config.provider, sdk, config.apiKey, model, buildAssistPrompt(request));
      return parseAssistResponse(raw);
    },
  };
}

/**
 * Provider-specific SDK call returning the model's raw text. Kept narrow and
 * defensive: only the three providers with a first-party SDK, each constructed
 * with the explicit key (never reading ambient env) and a bounded max-tokens.
 * Runs off the deterministic path, with a human reviewing the output.
 */
async function callSdk(
  provider: ProviderId,
  sdk: unknown,
  apiKey: string,
  model: string,
  prompt: string,
): Promise<string> {
  const mod = sdk as Record<string, unknown>;
  if (provider === 'claude') {
    const Anthropic = (mod['default'] ?? mod['Anthropic']) as new (opts: unknown) => {
      messages: { create: (opts: unknown) => Promise<{ content: { type: string; text?: string }[] }> };
    };
    const client = new Anthropic({ apiKey });
    const resp = await client.messages.create({
      model,
      max_tokens: 4096,
      messages: [{ role: 'user', content: prompt }],
    });
    return resp.content.map((block) => (block.type === 'text' ? (block.text ?? '') : '')).join('');
  }
  if (provider === 'codex') {
    const OpenAI = (mod['default'] ?? mod['OpenAI']) as new (opts: unknown) => {
      responses: { create: (opts: unknown) => Promise<{ output_text?: string }> };
    };
    const client = new OpenAI({ apiKey });
    const resp = await client.responses.create({ model, input: prompt });
    return resp.output_text ?? '';
  }
  if (provider === 'gemini') {
    const GoogleGenerativeAI = mod['GoogleGenerativeAI'] as new (key: string) => {
      getGenerativeModel: (opts: { model: string }) => {
        generateContent: (p: string) => Promise<{ response: { text: () => string } }>;
      };
    };
    const client = new GoogleGenerativeAI(apiKey);
    const genModel = client.getGenerativeModel({ model });
    const resp = await genModel.generateContent(prompt);
    return resp.response.text();
  }
  throw new AssistBackendUnavailableError(`no SDK call for provider "${provider}"`);
}
