/**
 * Unit tests for the AI-assist credential DISCOVERY gateway — C4 (#28).
 *
 * Binding spec: docs/stories/13-C4-ai-assisted-init.md (U4, EV5, OPT1), PRD §17
 * ("Auth — discovery & propose, never an assumed default"), and
 * docs/research/provider-matrix.md "AI-assist credential sources" (env-var
 * names + the discovery-ranking rule: api-key tier ranks above
 * subscription-session tier, per-provider order is the tie-break).
 *
 * These tests drive the PURE `discoverCredentialSources` with a HAND-ROLLED
 * fake `DiscoveryProbes`. `createDiscoveryProbes` (which touches the real
 * machine: PATH, env, keychain, a status subcommand) is NEVER called here — so
 * the suite is fully offline, makes no model call, spawns no CLI, and reads no
 * real credential. No test-double libraries; every probe is hand-built.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { discoverCredentialSources } from '../../dist/index.js';
import type { DiscoveryProbes, CredentialSource } from '../../dist/index.js';
import type { ProviderId } from '../../dist/index.js';

/**
 * Build a fake DiscoveryProbes from plain config — no network, no PATH walk,
 * no env reads, no spawning. `binaries` lists which CLIs resolve on PATH;
 * `env` maps env-var name -> value; `sessions` maps provider -> detail string
 * (its presence means an authed session was detected).
 */
function fakeProbes(config: {
  binaries?: readonly string[];
  env?: Readonly<Record<string, string>>;
  sessions?: Readonly<Partial<Record<ProviderId, string>>>;
}): DiscoveryProbes {
  const binaries = new Set(config.binaries ?? []);
  const env = config.env ?? {};
  const sessions = config.sessions ?? {};
  return {
    hasBinary: (binary) => binaries.has(binary),
    // Mirror the real probe's contract: empty string is treated as unset.
    getEnv: (name) => {
      const value = env[name];
      return value !== undefined && value !== '' ? value : undefined;
    },
    detectSession: (provider) => sessions[provider] ?? null,
  };
}

/** A synthetic, never-real secret value — constructed at runtime, never stored. */
function syntheticSecret(): string {
  return `sk-fake-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}

function bySameProvider(sources: readonly CredentialSource[], provider: ProviderId): CredentialSource[] {
  return sources.filter((s) => s.provider === provider);
}

describe('discoverCredentialSources()', () => {
  describe('U4 — per-provider source detection (env key vs. subscription session)', () => {
    it('proposes an api-key source for a provider whose env key is set, even with no binary on PATH', () => {
      // A bare env key is usable via the SDK with no CLI installed.
      const probes = fakeProbes({ env: { OPENAI_API_KEY: syntheticSecret() } });
      const sources = discoverCredentialSources(probes);
      assert.equal(sources.length, 1);
      assert.equal(sources[0]?.provider, 'codex');
      assert.equal(sources[0]?.kind, 'api-key');
    });

    it('proposes a subscription-session source when the binary is on PATH and a session marker is present', () => {
      const probes = fakeProbes({
        binaries: ['claude'],
        sessions: { claude: '~/.claude/.credentials.json present' },
      });
      const sources = discoverCredentialSources(probes);
      assert.equal(sources.length, 1);
      assert.equal(sources[0]?.provider, 'claude');
      assert.equal(sources[0]?.kind, 'subscription-session');
    });

    it('proposes no source for a provider with neither an env key nor a detectable session', () => {
      // gemini binary present but no key and no session marker -> nothing.
      const probes = fakeProbes({ binaries: ['gemini'] });
      const sources = discoverCredentialSources(probes);
      assert.deepEqual(sources, []);
    });
  });

  describe('U4 + matrix ranking — one provider with BOTH an env key and a session', () => {
    it('returns both sources for that provider with api-key ranked before subscription-session', () => {
      const probes = fakeProbes({
        binaries: ['claude'],
        env: { ANTHROPIC_API_KEY: syntheticSecret() },
        sessions: { claude: '~/.claude/.credentials.json present' },
      });
      const sources = discoverCredentialSources(probes);
      const claude = bySameProvider(sources, 'claude');
      assert.equal(claude.length, 2);
      // Order in the returned array: api-key first.
      assert.deepEqual(
        sources.map((s) => s.kind),
        ['api-key', 'subscription-session'],
      );
      // And the rank values agree with that order (lower = preferred).
      const apiKey = sources[0];
      const session = sources[1];
      assert.equal(apiKey?.kind, 'api-key');
      assert.equal(session?.kind, 'subscription-session');
      assert.ok(
        (apiKey?.rank ?? Infinity) < (session?.rank ?? -Infinity),
        'api-key rank must be strictly less than subscription-session rank',
      );
      // Concretely: claude order=0, api-key tier=0 -> 0; session tier=1 -> 10.
      assert.equal(apiKey?.rank, 0);
      assert.equal(session?.rank, 10);
    });
  });

  describe('matrix ranking — tiers across providers, provider order as the tie-break', () => {
    it('sorts the entire api-key tier before the entire subscription-session tier, ties broken by provider order', () => {
      // codex + gemini contribute api-key sources; claude + copilot contribute
      // subscription-session sources. Expected proposal order:
      //   api-key:   codex(order1) before gemini(order2)
      //   session:   claude(order0) before copilot(order3)
      // and the whole api-key tier precedes the whole session tier.
      const probes = fakeProbes({
        binaries: ['claude', 'copilot'],
        env: { OPENAI_API_KEY: syntheticSecret(), GEMINI_API_KEY: syntheticSecret() },
        sessions: {
          claude: '~/.claude/.credentials.json present',
          copilot: '~/.copilot/config.json present',
        },
      });
      const sources = discoverCredentialSources(probes);
      assert.deepEqual(
        sources.map((s) => `${s.provider}:${s.kind}`),
        [
          'codex:api-key',
          'gemini:api-key',
          'claude:subscription-session',
          'copilot:subscription-session',
        ],
      );
      // Ranks are monotonically non-decreasing across the returned list.
      const ranks = sources.map((s) => s.rank);
      assert.deepEqual([...ranks].sort((a, b) => a - b), ranks);
      // Concrete rank values: api-key tier = 0*10+order, session tier = 1*10+order.
      assert.deepEqual(ranks, [1, 2, 10, 13]);
    });

    it('orders two providers within the same api-key tier by provider order, not insertion', () => {
      // gemini(order2) and codex(order1) both have keys; codex must come first.
      const probes = fakeProbes({
        env: { GEMINI_API_KEY: syntheticSecret(), OPENAI_API_KEY: syntheticSecret() },
      });
      const sources = discoverCredentialSources(probes);
      assert.deepEqual(
        sources.map((s) => s.provider),
        ['codex', 'gemini'],
      );
    });
  });

  describe('U4 — each provider honors its own env-var names (per the matrix)', () => {
    it('detects the claude api-key via ANTHROPIC_API_KEY', () => {
      const sources = discoverCredentialSources(fakeProbes({ env: { ANTHROPIC_API_KEY: syntheticSecret() } }));
      assert.equal(sources.length, 1);
      assert.equal(sources[0]?.provider, 'claude');
      assert.equal(sources[0]?.detail, 'env ANTHROPIC_API_KEY');
    });

    it('detects the claude api-key via CLAUDE_CODE_OAUTH_TOKEN (CI fallback name)', () => {
      const sources = discoverCredentialSources(fakeProbes({ env: { CLAUDE_CODE_OAUTH_TOKEN: syntheticSecret() } }));
      assert.equal(sources.length, 1);
      assert.equal(sources[0]?.provider, 'claude');
      assert.equal(sources[0]?.detail, 'env CLAUDE_CODE_OAUTH_TOKEN');
    });

    it('prefers ANTHROPIC_API_KEY over CLAUDE_CODE_OAUTH_TOKEN when both are set (precedence order)', () => {
      const sources = discoverCredentialSources(
        fakeProbes({ env: { ANTHROPIC_API_KEY: syntheticSecret(), CLAUDE_CODE_OAUTH_TOKEN: syntheticSecret() } }),
      );
      const claude = bySameProvider(sources, 'claude');
      assert.equal(claude.length, 1);
      assert.equal(claude[0]?.detail, 'env ANTHROPIC_API_KEY');
    });

    it('detects the codex api-key via OPENAI_API_KEY', () => {
      const sources = discoverCredentialSources(fakeProbes({ env: { OPENAI_API_KEY: syntheticSecret() } }));
      assert.equal(sources[0]?.provider, 'codex');
      assert.equal(sources[0]?.detail, 'env OPENAI_API_KEY');
    });

    it('detects the gemini api-key via GEMINI_API_KEY', () => {
      const sources = discoverCredentialSources(fakeProbes({ env: { GEMINI_API_KEY: syntheticSecret() } }));
      assert.equal(sources[0]?.provider, 'gemini');
      assert.equal(sources[0]?.detail, 'env GEMINI_API_KEY');
    });

    it('detects the gemini api-key via GOOGLE_API_KEY (Vertex fallback name)', () => {
      const sources = discoverCredentialSources(fakeProbes({ env: { GOOGLE_API_KEY: syntheticSecret() } }));
      assert.equal(sources[0]?.provider, 'gemini');
      assert.equal(sources[0]?.detail, 'env GOOGLE_API_KEY');
    });

    it('detects the copilot api-key via COPILOT_GITHUB_TOKEN, GH_TOKEN, or GITHUB_TOKEN, in that precedence', () => {
      const viaCopilot = discoverCredentialSources(fakeProbes({ env: { COPILOT_GITHUB_TOKEN: syntheticSecret() } }));
      assert.equal(viaCopilot[0]?.provider, 'copilot');
      assert.equal(viaCopilot[0]?.detail, 'env COPILOT_GITHUB_TOKEN');

      const viaGh = discoverCredentialSources(fakeProbes({ env: { GH_TOKEN: syntheticSecret() } }));
      assert.equal(viaGh[0]?.detail, 'env GH_TOKEN');

      const viaGithub = discoverCredentialSources(fakeProbes({ env: { GITHUB_TOKEN: syntheticSecret() } }));
      assert.equal(viaGithub[0]?.detail, 'env GITHUB_TOKEN');

      // Precedence: COPILOT_GITHUB_TOKEN wins over GH_TOKEN wins over GITHUB_TOKEN.
      const all = discoverCredentialSources(
        fakeProbes({ env: { COPILOT_GITHUB_TOKEN: syntheticSecret(), GH_TOKEN: syntheticSecret(), GITHUB_TOKEN: syntheticSecret() } }),
      );
      assert.equal(bySameProvider(all, 'copilot').length, 1);
      assert.equal(all[0]?.detail, 'env COPILOT_GITHUB_TOKEN');
    });

    it("does not cross-attribute one provider's env var to another (an OpenAI key yields only a codex source)", () => {
      const sources = discoverCredentialSources(fakeProbes({ env: { OPENAI_API_KEY: syntheticSecret() } }));
      assert.deepEqual(
        sources.map((s) => s.provider),
        ['codex'],
      );
    });

    it('treats an empty-string env value as unset (no api-key source)', () => {
      const probes = fakeProbes({ env: { ANTHROPIC_API_KEY: '', OPENAI_API_KEY: '' } });
      const sources = discoverCredentialSources(probes);
      assert.deepEqual(sources, []);
    });

    it('falls through to the next env name when the first in precedence is empty', () => {
      // ANTHROPIC_API_KEY empty but CLAUDE_CODE_OAUTH_TOKEN set -> the token name wins.
      const sources = discoverCredentialSources(
        fakeProbes({ env: { ANTHROPIC_API_KEY: '', CLAUDE_CODE_OAUTH_TOKEN: syntheticSecret() } }),
      );
      assert.equal(sources.length, 1);
      assert.equal(sources[0]?.detail, 'env CLAUDE_CODE_OAUTH_TOKEN');
    });
  });

  describe('subscription-session requires the binary, not just a session marker', () => {
    it('proposes no session source when a session marker is present but the binary is absent from PATH', () => {
      // detectSession would return a detail, but hasBinary is false, so the
      // gateway must not even consider the session (and must not call into it).
      let detectCalls = 0;
      const probes: DiscoveryProbes = {
        hasBinary: () => false,
        getEnv: () => undefined,
        detectSession: (provider) => {
          detectCalls += 1;
          return provider === 'codex' ? '~/.codex/auth.json present' : null;
        },
      };
      const sources = discoverCredentialSources(probes);
      assert.deepEqual(sources, []);
      assert.equal(detectCalls, 0, 'session detection must be gated behind the binary check');
    });

    it('proposes the session source once both the binary and the marker are present', () => {
      const probes = fakeProbes({
        binaries: ['codex'],
        sessions: { codex: '~/.codex/auth.json present' },
      });
      const sources = discoverCredentialSources(probes);
      assert.equal(sources.length, 1);
      assert.equal(sources[0]?.kind, 'subscription-session');
      assert.equal(sources[0]?.detail, 'codex on PATH + ~/.codex/auth.json present');
    });
  });

  describe('EV5 — every source carries a caveat and a leak-free detail', () => {
    it('attaches a non-empty caveat and a non-empty detail to every returned source', () => {
      const probes = fakeProbes({
        binaries: ['claude', 'codex', 'gemini', 'copilot'],
        env: { ANTHROPIC_API_KEY: syntheticSecret(), OPENAI_API_KEY: syntheticSecret() },
        sessions: {
          claude: '~/.claude/.credentials.json present',
          gemini: '~/.gemini/oauth_creds.json present',
          copilot: 'macOS Keychain "copilot-cli" present',
        },
      });
      const sources = discoverCredentialSources(probes);
      assert.ok(sources.length > 0, 'fixture should yield several sources');
      for (const s of sources) {
        assert.equal(typeof s.caveat, 'string');
        assert.ok(s.caveat.length > 0, `caveat must be non-empty for ${s.provider}:${s.kind}`);
        assert.equal(typeof s.detail, 'string');
        assert.ok(s.detail.length > 0, `detail must be non-empty for ${s.provider}:${s.kind}`);
      }
    });

    it('formats an api-key detail as "env <NAME>" and never embeds the secret value', () => {
      const secret = syntheticSecret();
      const sources = discoverCredentialSources(fakeProbes({ env: { ANTHROPIC_API_KEY: secret } }));
      const source = sources[0];
      assert.equal(source?.kind, 'api-key');
      // Detail names the env var, not its value.
      assert.match(source?.detail ?? '', /^env [A-Z0-9_]+$/);
      assert.equal(source?.detail, 'env ANTHROPIC_API_KEY');
      assert.ok(!(source?.detail ?? '').includes(secret), 'detail must not contain the secret value');
      assert.ok(!(source?.caveat ?? '').includes(secret), 'caveat must not contain the secret value');
    });

    it('never leaks any env secret value into detail or caveat across a fully-populated discovery', () => {
      const secrets = {
        ANTHROPIC_API_KEY: syntheticSecret(),
        OPENAI_API_KEY: syntheticSecret(),
        GEMINI_API_KEY: syntheticSecret(),
        COPILOT_GITHUB_TOKEN: syntheticSecret(),
      };
      const probes = fakeProbes({
        binaries: ['claude', 'codex', 'gemini', 'copilot'],
        env: secrets,
        sessions: { codex: '~/.codex/auth.json present' },
      });
      const sources = discoverCredentialSources(probes);
      const haystack = sources.map((s) => `${s.detail} ${s.caveat}`).join(' ');
      for (const value of Object.values(secrets)) {
        assert.ok(!haystack.includes(value), 'no secret value may appear in any detail/caveat');
      }
    });

    it("surfaces a session detail that names only a marker, never a token value", () => {
      const probes = fakeProbes({
        binaries: ['codex'],
        sessions: { codex: '`codex login status` exit 0' },
      });
      const sources = discoverCredentialSources(probes);
      assert.equal(sources[0]?.detail, 'codex on PATH + `codex login status` exit 0');
    });
  });

  describe('OPT1 precondition — nothing discovered yields an empty list', () => {
    it('returns [] when probes report no binaries, no env keys, and no sessions', () => {
      // The fallback/fail decision is the CLI's; the gateway just reports empty.
      const probes = fakeProbes({});
      const sources = discoverCredentialSources(probes);
      assert.deepEqual(sources, []);
    });

    it('returns [] even when binaries exist but no env key and no session back them', () => {
      const probes = fakeProbes({ binaries: ['claude', 'codex', 'gemini', 'copilot'] });
      assert.deepEqual(discoverCredentialSources(probes), []);
    });
  });

  describe('determinism — identical probes produce identical output', () => {
    it('returns deep-equal results when called twice with the same probes', () => {
      const probes = fakeProbes({
        binaries: ['claude', 'copilot'],
        env: { OPENAI_API_KEY: syntheticSecret(), GEMINI_API_KEY: syntheticSecret() },
        sessions: {
          claude: '~/.claude/.credentials.json present',
          copilot: '~/.copilot/config.json present',
        },
      });
      const first = discoverCredentialSources(probes);
      const second = discoverCredentialSources(probes);
      assert.deepEqual(first, second);
    });

    it('produces a stable ordering independent of how the probe data was constructed', () => {
      // Two probe objects with the same facts but built in a different order
      // must yield byte-identical proposal lists.
      const keyA = syntheticSecret();
      const keyB = syntheticSecret();
      const a = fakeProbes({ env: { GEMINI_API_KEY: keyB, OPENAI_API_KEY: keyA } });
      const b = fakeProbes({ env: { OPENAI_API_KEY: keyA, GEMINI_API_KEY: keyB } });
      assert.deepEqual(discoverCredentialSources(a), discoverCredentialSources(b));
    });
  });
});
