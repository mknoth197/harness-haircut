/**
 * `buildAiResolver` — UNIT test (testing.md category 1), layer-3 gateway for
 * C4 (#28). Drives the composed `ContradictionResolver` entirely offline:
 * every collaborator (`backend`, `confirmEgress`, `approveMerge`, `fallback`,
 * `warn`) is a hand-rolled fake — no SDK, no CLI, no network, no model call.
 *
 * The resolver layers the C5 egress policy (`planEgress`, real, from dist)
 * over the backend, so each test threads a `Contradiction` through the real
 * classification + secret-scan before asserting on the backend/fallback path.
 *
 * EARS coverage (docs/stories/13-C4-ai-assisted-init.md + PRD §17 +
 * provider-matrix "AI-assist credential sources"):
 *   EV1 — equivalent → choose, no merge prompt.
 *   EV2 — merge proposed → approval gate (approve writes merge, decline falls back).
 *   EV3/UN3 — egress consent declined → backend never called, fallback, warning.
 *   UN1 — backend throws → fallback, warning, no crash.
 *   C5 gate — a high-confidence secret in a candidate blocks egress BEFORE the
 *             backend is reached (the load-bearing security property).
 *   C5 redaction (EV2 of C5) — only POST-redaction bytes reach the backend.
 *   default-deny — every candidate denies → backend never called, fallback.
 * Plus: confirmEgress receives the plan and the backend's destination.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { buildAiResolver, defaultEgressFlags } from '../../dist/index.js';
import type {
  AssistBackend,
  AssistProposal,
  AssistRequest,
  AiResolverDeps,
  CandidateText,
  Contradiction,
  ContradictionResolver,
  EgressDestination,
  EgressFlags,
  EgressPlan,
  Resolution,
} from '../../dist/index.js';

// --- synthetic secrets (constructed at runtime; never a real credential) ---

/** AWS access key id shape: AKIA + 16 uppercase chars. The `aws-access-key-id`
 *  rule is unconditional (no keyword/entropy gate) → a deterministic high finding. */
const AWS_KEY = 'AKIA' + 'A'.repeat(16);

// --- fixed destination shown in the disclosure (EV3/EV5) ---

const DESTINATION: EgressDestination = {
  provider: 'anthropic',
  model: 'claude-sonnet-4-6',
  sourceKind: 'subscription-session',
  retentionCaveat: 'provider may retain prompts per its policy',
  tosCaveat: 'claude -p subscription session — metered against your plan',
};

// --- builders ---

/** A candidate for a contradiction slot. `normalizedText` only feeds the
 *  deterministic comparer (irrelevant here), so we mirror `text`. */
function candidate(
  providerId: CandidateText['providerId'],
  path: string,
  text: string,
): CandidateText {
  return { providerId, path, text, normalizedText: text };
}

function contradiction(candidates: CandidateText[], slot = 'root-instructions'): Contradiction {
  return { slot, candidates, plusSkip: true };
}

/** The common two-candidate root-instructions conflict, both allow-class. */
function rootConflict(): Contradiction {
  return contradiction([
    candidate('codex', 'AGENTS.md', 'Run the suite with npm test.\n'),
    candidate('claude', 'CLAUDE.md', 'Use `npm test` to run all tests.\n'),
  ]);
}

/** Records every `AssistRequest` it is handed; either resolves a fixed
 *  proposal or rejects with a fixed error (the UN1 path). */
interface FakeBackend extends AssistBackend {
  readonly calls: AssistRequest[];
}

function fakeBackend(
  outcome: { proposal: AssistProposal } | { throwError: Error },
): FakeBackend {
  const calls: AssistRequest[] = [];
  return {
    destination: DESTINATION,
    calls,
    proposeResolution(request: AssistRequest): Promise<AssistProposal> {
      calls.push(request);
      if ('throwError' in outcome) {
        return Promise.reject(outcome.throwError);
      }
      return Promise.resolve(outcome.proposal);
    },
  };
}

/** A sentinel resolution distinguishable from any AI outcome, so a test can
 *  assert the resolver returned EXACTLY the fallback's answer. */
const FALLBACK_RESOLUTION: Resolution = { kind: 'choose', index: 1 };

/** Deterministic fallback that records the contradictions it was asked about. */
function recordingFallback(): { resolver: ContradictionResolver; calls: Contradiction[] } {
  const calls: Contradiction[] = [];
  return {
    calls,
    resolver: (c: Contradiction): Promise<Resolution> => {
      calls.push(c);
      return Promise.resolve(FALLBACK_RESOLUTION);
    },
  };
}

/** Records every consent prompt with the plan + destination it received. */
function recordingConfirmEgress(answer: boolean): {
  fn: AiResolverDeps['confirmEgress'];
  calls: { plan: EgressPlan; destination: EgressDestination }[];
} {
  const calls: { plan: EgressPlan; destination: EgressDestination }[] = [];
  return {
    calls,
    fn: (plan: EgressPlan, destination: EgressDestination): Promise<boolean> => {
      calls.push({ plan, destination });
      return Promise.resolve(answer);
    },
  };
}

/** Records every merge-approval prompt with its arguments. */
function recordingApproveMerge(answer: boolean): {
  fn: AiResolverDeps['approveMerge'];
  calls: { slot: string; proposedText: string; candidates: readonly CandidateText[] }[];
} {
  const calls: { slot: string; proposedText: string; candidates: readonly CandidateText[] }[] = [];
  return {
    calls,
    fn: (
      slot: string,
      proposedText: string,
      candidates: readonly CandidateText[],
    ): Promise<boolean> => {
      calls.push({ slot, proposedText, candidates });
      return Promise.resolve(answer);
    },
  };
}

function warnCollector(): { warn: (m: string) => void; messages: string[] } {
  const messages: string[] = [];
  return { warn: (m: string) => messages.push(m), messages };
}

/** Assembles `AiResolverDeps` with sensible recording defaults; override any. */
function deps(overrides: Partial<AiResolverDeps> & { backend: AssistBackend }): {
  resolver: ContradictionResolver;
  built: AiResolverDeps;
} {
  const built: AiResolverDeps = {
    egressFlags: defaultEgressFlags(),
    confirmEgress: () => Promise.resolve(true),
    approveMerge: () => Promise.resolve(true),
    fallback: () => Promise.resolve(FALLBACK_RESOLUTION),
    warn: () => {},
    ...overrides,
  };
  return { resolver: buildAiResolver(built), built };
}

describe('buildAiResolver()', () => {
  it('reports agreement as choose index 0 without prompting for a merge (EV1)', async () => {
    const backend = fakeBackend({ proposal: { kind: 'equivalent' } });
    const approve = recordingApproveMerge(true);
    const { resolver } = deps({ backend, approveMerge: approve.fn });

    const result = await resolver(rootConflict());

    assert.deepEqual(result, { kind: 'choose', index: 0 });
    assert.equal(backend.calls.length, 1, 'the backend was asked once');
    assert.equal(approve.calls.length, 0, 'no merge prompt is shown for an equivalent verdict');
  });

  it('returns the approved merge text when the human approves the proposal (EV2)', async () => {
    const backend = fakeBackend({ proposal: { kind: 'merge', text: 'MERGED' } });
    const approve = recordingApproveMerge(true);
    const { resolver } = deps({ backend, approveMerge: approve.fn });

    const result = await resolver(rootConflict());

    assert.deepEqual(result, { kind: 'merge', text: 'MERGED' });
    assert.equal(approve.calls.length, 1, 'the merge was shown for approval');
    assert.equal(approve.calls[0]!.proposedText, 'MERGED');
    assert.equal(approve.calls[0]!.slot, 'root-instructions');
  });

  it('falls back to the deterministic resolver when the human declines the merge (EV2)', async () => {
    const backend = fakeBackend({ proposal: { kind: 'merge', text: 'MERGED' } });
    const approve = recordingApproveMerge(false);
    const fallback = recordingFallback();
    const c = rootConflict();
    const { resolver } = deps({ backend, approveMerge: approve.fn, fallback: fallback.resolver });

    const result = await resolver(c);

    assert.deepEqual(result, FALLBACK_RESOLUTION, 'returns exactly the fallback Resolution');
    assert.equal(fallback.calls.length, 1, 'the fallback was consulted');
    assert.equal(fallback.calls[0], c, 'the fallback received the same contradiction');
  });

  it('never calls the backend and falls back with a warning when egress consent is declined (EV3/UN3)', async () => {
    const backend = fakeBackend({ proposal: { kind: 'merge', text: 'MERGED' } });
    const confirm = recordingConfirmEgress(false);
    const fallback = recordingFallback();
    const { warn, messages } = warnCollector();
    const c = rootConflict();
    const { resolver } = deps({
      backend,
      confirmEgress: confirm.fn,
      fallback: fallback.resolver,
      warn,
    });

    const result = await resolver(c);

    assert.equal(backend.calls.length, 0, 'no bytes reach the backend without consent');
    assert.equal(confirm.calls.length, 1, 'consent was requested exactly once');
    assert.deepEqual(result, FALLBACK_RESOLUTION);
    assert.equal(fallback.calls[0], c);
    assert.equal(messages.length, 1);
    assert.match(messages[0]!, /consent declined/);
  });

  it('blocks egress before the backend when a candidate carries a high-confidence secret (C5 hard block)', async () => {
    // The key security property: a secret-bearing candidate never reaches the
    // model. AGENTS.md is allow-class, so only the C5 secret scan can stop it.
    const backend = fakeBackend({ proposal: { kind: 'merge', text: 'MERGED' } });
    const confirm = recordingConfirmEgress(true);
    const fallback = recordingFallback();
    const { warn, messages } = warnCollector();
    const c = contradiction([
      candidate('codex', 'AGENTS.md', `deploy key: ${AWS_KEY}\n`),
      candidate('claude', 'CLAUDE.md', 'Use `npm test` to run all tests.\n'),
    ]);
    const { resolver } = deps({
      backend,
      confirmEgress: confirm.fn,
      fallback: fallback.resolver,
      warn,
    });

    const result = await resolver(c);

    assert.equal(backend.calls.length, 0, 'the secret-bearing candidate never reaches the backend');
    assert.equal(confirm.calls.length, 0, 'a blocked plan is never offered for consent');
    assert.deepEqual(result, FALLBACK_RESOLUTION);
    assert.equal(fallback.calls[0], c);
    assert.match(messages[0]!, /blocked/);
    assert.equal(messages[0]!.includes(AWS_KEY), false, 'the warning never echoes the raw secret');
  });

  it('falls back with a warning when the backend throws, without crashing (UN1)', async () => {
    const backend = fakeBackend({ throwError: new Error('rate limited') });
    const fallback = recordingFallback();
    const { warn, messages } = warnCollector();
    const c = rootConflict();
    const { resolver } = deps({ backend, fallback: fallback.resolver, warn });

    // The resolver awaits cleanly (the backend's rejection is caught internally) —
    // a thrown error here would fail the test, proving "never crashes init" (UN1).
    const result = await resolver(c);

    assert.deepEqual(result, FALLBACK_RESOLUTION);
    assert.equal(fallback.calls[0], c);
    assert.equal(messages.length, 1);
    assert.match(messages[0]!, /backend failed/);
    assert.match(messages[0]!, /rate limited/, 'the error message is surfaced in the warning');
  });

  it('sends only POST-redaction bytes to the backend when a secret rule is allowed (C5 redaction)', async () => {
    // With the rule allow-listed, the secret is redacted (not blocked); the
    // backend must receive the [REDACTED:…] placeholder, never the raw secret.
    const backend = fakeBackend({ proposal: { kind: 'equivalent' } });
    const flags: EgressFlags = { ...defaultEgressFlags(), allowSecretRules: ['aws-access-key-id'] };
    const c = contradiction([
      candidate('codex', 'AGENTS.md', `token ${AWS_KEY} end\n`),
      candidate('claude', 'CLAUDE.md', 'Use `npm test` to run all tests.\n'),
    ]);
    const { resolver } = deps({ backend, egressFlags: flags });

    await resolver(c);

    assert.equal(backend.calls.length, 1, 'redaction lets the (cleaned) bytes through to the backend');
    const sent = backend.calls[0]!.candidates;
    const agentsCandidate = sent.find((cand) => cand.path === 'AGENTS.md');
    assert.ok(agentsCandidate, 'the AGENTS.md candidate reached the backend');
    assert.match(agentsCandidate.text, /\[REDACTED:aws-access-key-id\]/);
    assert.equal(agentsCandidate.text.includes(AWS_KEY), false, 'the raw secret never leaves');
  });

  it('never calls the backend and falls back when policy withholds every candidate (default-deny)', async () => {
    // `.claude/settings.json` is a hard-deny exact path; with no --assist-include
    // flag nothing is egress-eligible, so there is nothing for the model to read.
    const backend = fakeBackend({ proposal: { kind: 'merge', text: 'MERGED' } });
    const confirm = recordingConfirmEgress(true);
    const fallback = recordingFallback();
    const { warn, messages } = warnCollector();
    const c = contradiction([
      candidate('claude', '.claude/settings.json', '{"hooks":{}}\n'),
      candidate('codex', '.codex/config.toml', '[features]\n'),
    ]);
    const { resolver } = deps({
      backend,
      confirmEgress: confirm.fn,
      fallback: fallback.resolver,
      warn,
    });

    const result = await resolver(c);

    assert.equal(backend.calls.length, 0, 'no egress-eligible candidates means no backend call');
    assert.deepEqual(result, FALLBACK_RESOLUTION);
    assert.equal(fallback.calls[0], c);
    assert.match(messages[0]!, /no egress-eligible candidates/);
  });

  it('passes the egress plan and the backend destination to the consent callback (EV3)', async () => {
    const backend = fakeBackend({ proposal: { kind: 'equivalent' } });
    const confirm = recordingConfirmEgress(true);
    const { resolver } = deps({ backend, confirmEgress: confirm.fn });

    await resolver(rootConflict());

    assert.equal(confirm.calls.length, 1);
    assert.equal(
      confirm.calls[0]!.destination,
      DESTINATION,
      'the backend.destination object reaches the consent callback',
    );
    assert.equal(confirm.calls[0]!.plan.decision, 'send', 'the plan handed to consent is the real EgressPlan');
  });
});
