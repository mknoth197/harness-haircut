/**
 * AI-assist BACKENDS — UNIT test (testing.md category 1), layer-3 gateway for
 * C4 (#28) U2/U5/EV5 + threat-model Finding 1. Drives both backends entirely
 * OFFLINE: every spawn/import surface is the injected fake the code exposes, so
 * there is NO network, NO real provider-CLI spawn, and NO real model call here.
 *
 * The load-bearing security property under test (Finding 1, High): the provider
 * CLI must NOT auto-load the untrusted repo's config. The CLI backend enforces
 * that by spawning in a fresh scratch dir (never the repo), passing the prompt
 * on stdin (never argv/disk), passing each CLI's ignore-project-config flag, and
 * failing CLOSED (no spawn at all) if the scratch dir is inside the repo.
 *
 * Coverage:
 *   parseAssistResponse — JSON shapes, fence/prose tolerance, throw paths.
 *   buildAssistPrompt — slot + per-candidate provider/path/text + strict-JSON.
 *   cliInvocation — per-provider isolation flags; model flag presence.
 *   curatedEnv — keep PATH/HOME/USER/LANG/LC_ALL/TMPDIR, drop everything else.
 *   createCliBackend — Finding-1 isolation, fail-closed, exit-code → throw.
 *   createSdkBackend — lazy import, UN2 on absent/unsupported SDK, happy path.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAssistPrompt,
  parseAssistResponse,
  cliInvocation,
  curatedEnv,
  createCliBackend,
  createSdkBackend,
  AssistBackendUnavailableError,
} from '../../dist/index.js';
import type {
  AssistRequest,
  CliSpawn,
  CliSpawnRequest,
  CliSpawnResult,
  CliBackendConfig,
  SdkBackendConfig,
  SdkLoader,
} from '../../dist/index.js';

// --- builders & fakes (hand-rolled; no test-double libraries) -----------------

/** A minimal two-candidate request for one logical slot. */
function makeRequest(): AssistRequest {
  return {
    slot: 'root-instructions',
    candidates: [
      { providerId: 'claude', path: 'CLAUDE.md', text: 'Always run the linter.' },
      { providerId: 'gemini', path: 'GEMINI.md', text: 'Run the linter before pushing.' },
    ],
  };
}

/** Records every CliSpawnRequest and returns a canned result. */
function recordingSpawn(result: CliSpawnResult): { spawn: CliSpawn; calls: CliSpawnRequest[] } {
  const calls: CliSpawnRequest[] = [];
  const spawn: CliSpawn = async (request) => {
    calls.push(request);
    return result;
  };
  return { spawn, calls };
}

/** A valid {"equivalent":true} proposal wrapped in claude's JSON stdout envelope. */
function claudeEnvelope(text: string): string {
  return JSON.stringify({ result: text });
}

/** Base CLI config; tests override per case. repoRoot is a synthetic absolute path. */
function cliConfig(overrides: Partial<CliBackendConfig> = {}): CliBackendConfig {
  const repoRoot = '/tmp/untrusted-repo';
  return {
    provider: 'claude',
    model: null,
    repoRoot,
    makeScratchDir: () => '/tmp/scratch-xyz',
    spawn: recordingSpawn({ stdout: claudeEnvelope('{"equivalent":true}'), exitCode: 0, stderr: '' }).spawn,
    ...overrides,
  };
}

// --- parseAssistResponse ------------------------------------------------------

describe('parseAssistResponse', () => {
  it('maps {"equivalent":true} to an equivalent proposal', () => {
    assert.deepEqual(parseAssistResponse('{"equivalent":true}'), { kind: 'equivalent' });
  });

  it('maps {"equivalent":false,"merged":"X"} to a merge proposal carrying the text', () => {
    assert.deepEqual(parseAssistResponse('{"equivalent":false,"merged":"X"}'), {
      kind: 'merge',
      text: 'X',
    });
  });

  it('tolerates a ```json code fence and surrounding prose around the object', () => {
    const raw = [
      "Sure — here's my verdict.",
      '```json',
      '{"equivalent": false, "merged": "merged body"}',
      '```',
      'Let me know if that works.',
    ].join('\n');
    assert.deepEqual(parseAssistResponse(raw), { kind: 'merge', text: 'merged body' });
  });

  it('throws when the output contains no JSON object', () => {
    assert.throws(() => parseAssistResponse('no json here, just prose'), /no parseable JSON/);
  });

  it('throws when the extracted object is invalid JSON', () => {
    // A balanced {...} that is not valid JSON (unquoted key, trailing comma).
    assert.throws(() => parseAssistResponse('{equivalent: true,}'), /invalid JSON/);
  });

  it('throws when the JSON has neither equivalent:true nor a non-empty merged', () => {
    assert.throws(() => parseAssistResponse('{"equivalent":false}'), /neither equivalent/);
  });

  it('throws when merged is present but empty after trimming', () => {
    assert.throws(() => parseAssistResponse('{"equivalent":false,"merged":"   "}'), /neither equivalent/);
  });
});

// --- buildAssistPrompt --------------------------------------------------------

describe('buildAssistPrompt', () => {
  it('includes the slot, each candidate provider/path/text, and a strict-JSON instruction', () => {
    const prompt = buildAssistPrompt(makeRequest());
    // The slot.
    assert.match(prompt, /Slot: root-instructions/);
    // Each candidate's providerId, path, and text.
    assert.match(prompt, /claude: CLAUDE\.md/);
    assert.match(prompt, /Always run the linter\./);
    assert.match(prompt, /gemini: GEMINI\.md/);
    assert.match(prompt, /Run the linter before pushing\./);
    // Instructs a JSON-only reply with the exact equivalent/merged shape.
    assert.match(prompt, /ONLY a JSON object/);
    assert.match(prompt, /"equivalent": true/);
    assert.match(prompt, /"merged"/);
  });
});

// --- cliInvocation ------------------------------------------------------------

describe('cliInvocation', () => {
  it('encodes claude isolation flags --strict-mcp-config and --output-format json', () => {
    const { binary, args } = cliInvocation('claude', null);
    assert.equal(binary, 'claude');
    assert.ok(args.includes('--strict-mcp-config'), 'expected --strict-mcp-config');
    assert.ok(args.includes('--output-format'), 'expected --output-format');
    assert.ok(args.includes('json'), 'expected json output format value');
  });

  it('encodes codex isolation flag --skip-git-repo-check and reads stdin via a "-" arg', () => {
    const { binary, args } = cliInvocation('codex', null);
    assert.equal(binary, 'codex');
    assert.ok(args.includes('exec'), 'expected the exec subcommand');
    assert.ok(args.includes('--skip-git-repo-check'), 'expected --skip-git-repo-check');
    assert.ok(args.includes('-'), 'expected the "-" stdin arg');
  });

  it('encodes the gemini --output-format json flag', () => {
    const { binary, args } = cliInvocation('gemini', null);
    assert.equal(binary, 'gemini');
    assert.ok(args.includes('--output-format'), 'expected --output-format');
    assert.ok(args.includes('json'), 'expected json output format value');
  });

  it('encodes copilot --no-custom-instructions and -s without a json flag', () => {
    const { binary, args } = cliInvocation('copilot', null);
    assert.equal(binary, 'copilot');
    assert.ok(args.includes('--no-custom-instructions'), 'expected --no-custom-instructions');
    assert.ok(args.includes('-s'), 'expected -s');
    assert.ok(!args.includes('--output-format'), 'copilot is text-only, no --output-format');
    assert.ok(!args.includes('json'), 'copilot is text-only, no json flag');
  });

  it('adds the model flag when a model is given and omits it when null', () => {
    const withModel = cliInvocation('claude', 'claude-sonnet-4-6');
    assert.ok(withModel.args.includes('--model'), 'expected --model flag');
    assert.ok(withModel.args.includes('claude-sonnet-4-6'), 'expected the model value');

    const withoutModel = cliInvocation('claude', null);
    assert.ok(!withoutModel.args.includes('--model'), 'null model must omit --model');
  });
});

// --- curatedEnv ---------------------------------------------------------------

describe('curatedEnv', () => {
  it('keeps only PATH/HOME/USER/LANG/LC_ALL/TMPDIR from the source env', () => {
    const source: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      HOME: '/home/me',
      USER: 'me',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      TMPDIR: '/tmp',
    };
    assert.deepEqual(curatedEnv(source), source);
  });

  it('drops behavior-changing and arbitrary variables the parent env might carry', () => {
    const source: NodeJS.ProcessEnv = {
      PATH: '/usr/bin',
      HOME: '/home/me',
      // Planted hostile / behavior-changing vars that MUST disappear:
      CLAUDE_CONFIG_DIR: '/home/me/untrusted/.claude',
      NODE_OPTIONS: '--require /tmp/evil.js',
      ANTHROPIC_API_KEY: 'planted-should-not-leak',
      SOME_ARBITRARY_VAR: 'x',
    };
    const env = curatedEnv(source);
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.HOME, '/home/me');
    assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
    assert.equal(env.NODE_OPTIONS, undefined);
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.SOME_ARBITRARY_VAR, undefined);
  });
});

// --- createCliBackend (Finding-1 security tests) ------------------------------

describe('createCliBackend', () => {
  it('exposes a subscription-session destination with a non-empty retention caveat', () => {
    const backend = createCliBackend(cliConfig());
    assert.equal(backend.destination.sourceKind, 'subscription-session');
    assert.notEqual(backend.destination.retentionCaveat.trim(), '');
  });

  it('spawns in the scratch dir, never the repo root nor a path under it', async () => {
    const scratch = '/tmp/scratch-outside';
    const { spawn, calls } = recordingSpawn({
      stdout: claudeEnvelope('{"equivalent":true}'),
      exitCode: 0,
      stderr: '',
    });
    const backend = createCliBackend(
      cliConfig({ repoRoot: '/tmp/untrusted-repo', makeScratchDir: () => scratch, spawn }),
    );
    await backend.proposeResolution(makeRequest());

    assert.equal(calls.length, 1);
    const req = calls[0]!;
    assert.equal(req.cwd, scratch);
    assert.notEqual(req.cwd, '/tmp/untrusted-repo');
    assert.ok(!req.cwd.startsWith('/tmp/untrusted-repo/'), 'cwd must not be under the repo root');
  });

  it('delivers the prompt on stdin (request.input), never in argv', async () => {
    const { spawn, calls } = recordingSpawn({
      stdout: claudeEnvelope('{"equivalent":true}'),
      exitCode: 0,
      stderr: '',
    });
    const backend = createCliBackend(cliConfig({ spawn }));
    const request = makeRequest();
    await backend.proposeResolution(request);

    const req = calls[0]!;
    // The candidate text appears in stdin...
    assert.match(req.input, /Always run the linter\./);
    assert.equal(req.input, buildAssistPrompt(request));
    // ...and NOT in any argv entry.
    for (const arg of req.args) {
      assert.ok(!arg.includes('Always run the linter.'), `prompt text leaked into argv: ${arg}`);
    }
  });

  it('passes the provider ignore-project-config flag in argv and a positive timeout', async () => {
    const { spawn, calls } = recordingSpawn({
      stdout: claudeEnvelope('{"equivalent":true}'),
      exitCode: 0,
      stderr: '',
    });
    const backend = createCliBackend(cliConfig({ provider: 'claude', spawn }));
    await backend.proposeResolution(makeRequest());

    const req = calls[0]!;
    assert.ok(req.args.includes('--strict-mcp-config'), 'expected the ignore-project-config flag');
    assert.ok(req.timeoutMs > 0, 'expected a bounded positive timeout');
  });

  it('throws when the spawn returns a non-zero exit code', async () => {
    const { spawn } = recordingSpawn({ stdout: '', exitCode: 1, stderr: 'not logged in' });
    const backend = createCliBackend(cliConfig({ spawn }));
    await assert.rejects(() => backend.proposeResolution(makeRequest()), /exited 1/);
  });

  it('fails closed without spawning when the scratch dir is inside the repo root', async () => {
    const repoRoot = '/tmp/untrusted-repo';
    const { spawn, calls } = recordingSpawn({
      stdout: claudeEnvelope('{"equivalent":true}'),
      exitCode: 0,
      stderr: '',
    });
    // makeScratchDir hands back a path INSIDE the repo — the backend must refuse.
    const backend = createCliBackend(
      cliConfig({ repoRoot, makeScratchDir: () => `${repoRoot}/.scratch`, spawn }),
    );
    await assert.rejects(
      () => backend.proposeResolution(makeRequest()),
      /refusing to spawn the assist CLI inside the repo/,
    );
    assert.equal(calls.length, 0, 'fail-closed: the spawn must never be called');
  });
});

// --- createSdkBackend ---------------------------------------------------------

describe('createSdkBackend', () => {
  /** Base SDK config; synthetic key constructed at runtime (never a real cred). */
  function sdkConfig(overrides: Partial<SdkBackendConfig> = {}): SdkBackendConfig {
    return {
      provider: 'claude',
      model: null,
      apiKey: 'sk-' + 'x'.repeat(20),
      load: async () => ({}),
      ...overrides,
    };
  }

  it('exposes an api-key destination and falls back to a per-provider default model when null', () => {
    const backend = createSdkBackend(sdkConfig({ provider: 'claude', model: null }));
    assert.equal(backend.destination.sourceKind, 'api-key');
    // Per-provider default constant (SDK_DEFAULT_MODEL.claude).
    assert.equal(backend.destination.model, 'claude-sonnet-4-6');
  });

  it('throws AssistBackendUnavailableError with exit 3 and an install hint when the SDK module is absent', async () => {
    const load: SdkLoader = async () => {
      throw new Error('Cannot find module');
    };
    const backend = createSdkBackend(sdkConfig({ provider: 'claude', load }));
    await assert.rejects(
      () => backend.proposeResolution(makeRequest()),
      (err: unknown) => {
        assert.ok(err instanceof AssistBackendUnavailableError);
        assert.equal((err as AssistBackendUnavailableError).exitCode, 3);
        assert.match((err as Error).message, /npm i -D @anthropic-ai\/sdk/);
        return true;
      },
    );
  });

  it('throws AssistBackendUnavailableError for copilot, which has no SDK backend', async () => {
    const backend = createSdkBackend(sdkConfig({ provider: 'copilot' }));
    await assert.rejects(
      () => backend.proposeResolution(makeRequest()),
      (err: unknown) => {
        assert.ok(err instanceof AssistBackendUnavailableError);
        assert.equal((err as AssistBackendUnavailableError).exitCode, 3);
        return true;
      },
    );
  });

  it('does not call the loader at construction time, only inside proposeResolution', async () => {
    let loadCalls = 0;
    const load: SdkLoader = async () => {
      loadCalls += 1;
      return claudeSdkModule('{"equivalent":true}');
    };
    const backend = createSdkBackend(sdkConfig({ provider: 'claude', load }));
    assert.equal(loadCalls, 0, 'loader must be lazy — no import at createSdkBackend() time');

    await backend.proposeResolution(makeRequest());
    assert.equal(loadCalls, 1, 'loader must be invoked once when proposeResolution runs');
  });

  it('returns an equivalent proposal on the happy path through a fake claude SDK module', async () => {
    const load: SdkLoader = async () => claudeSdkModule('{"equivalent":true}');
    const backend = createSdkBackend(sdkConfig({ provider: 'claude', load }));
    const proposal = await backend.proposeResolution(makeRequest());
    assert.deepEqual(proposal, { kind: 'equivalent' });
  });
});

/**
 * A fake `@anthropic-ai/sdk` module shaped like the real one: a default-export
 * class whose `messages.create` returns a content array of text blocks. The
 * canned text is whatever the model would have replied with.
 */
function claudeSdkModule(replyText: string): unknown {
  return {
    default: class {
      messages = {
        create: async () => ({ content: [{ type: 'text', text: replyText }] }),
      };
    },
  };
}
