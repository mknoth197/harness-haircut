/**
 * AI-assist contradiction resolver — C4 (#28), layer 3 (gateway).
 *
 * `buildAiResolver` composes a `ContradictionResolver` (the C3 seam the `init`
 * use case already injects) from three collaborators, so the use case is
 * UNCHANGED in shape and the entities/use-case layers stay SDK-free:
 *
 *   - an `AssistBackend` (the only thing that talks to a model — an SDK or a
 *     headless CLI; supplied by the composition root, real or fake),
 *   - the pure C5 egress policy (`planEgress`) + the layer-4 consent prompt,
 *   - the deterministic `fallback` resolver (C3's readline flow).
 *
 * Every model call is gated: candidate bytes are classified + secret-scanned
 * by C5 BEFORE the backend sees them, the human consents to the exact egress
 * (EV3/EV4), and an AI-proposed merge needs explicit human approval (EV2).
 * ANY block, declined consent, declined merge, empty-after-policy input, or
 * backend error falls back to the deterministic resolver for that slot and
 * sends nothing (UN1/UN3) — assist is always safe to not have.
 *
 * This module performs NO I/O itself: it spawns no process and imports no
 * provider SDK. The backend encapsulates that (and is built only on the
 * `init --assist` path), keeping the determinism boundary intact.
 */
import type {
  CandidateText,
  Contradiction,
  ContradictionResolver,
  Resolution,
} from '../entities/contradiction.js';
import type {
  EgressDestination,
  EgressFileInput,
  EgressFlags,
  EgressPlan,
  SecretScanOptions,
} from '../entities/index.js';
import { planEgress, renderEgressBlock } from '../entities/index.js';

/** What the resolver asks a backend to do for one contradiction. */
export interface AssistRequest {
  /** The contradiction slot (`root-instructions` / `skill:*` / `fragment:*`). */
  slot: string;
  /**
   * The candidates the model may reason over — POST-redaction text only (what
   * C5 cleared to send), each tagged with its provider + source path.
   */
  candidates: { providerId: string; path: string; text: string }[];
}

/**
 * The backend's judgment for one contradiction:
 *   - `equivalent` (EV1): the candidates say the same thing in different words
 *     — no real conflict, so the command must NOT prompt for this slot.
 *   - `merge` (EV2): a single proposed canonical text superseding all
 *     candidates — shown to the human as a diff for explicit approval.
 */
export type AssistProposal = { kind: 'equivalent' } | { kind: 'merge'; text: string };

/**
 * The model-talking collaborator. Implemented by the SDK backend (api-key,
 * lazy `import()`) and the CLI-headless backend (subscription session,
 * `execFile`) in the composition root; a fake drives the tests. A throw is the
 * UN1 error path (the resolver falls back, never crashes `init`).
 */
export interface AssistBackend {
  /** Destination shown in the egress disclosure (provider, model, kind, caveats). */
  readonly destination: EgressDestination;
  /** Single, bounded, non-interactive judgment for one contradiction. */
  proposeResolution: (request: AssistRequest) => Promise<AssistProposal>;
}

/** Layer-4 collaborators + C5 flags the resolver is composed from. */
export interface AiResolverDeps {
  backend: AssistBackend;
  /** C5 widening/redaction flags from the CLI (`--assist-include` / `--assist-allow-secret`). */
  egressFlags: EgressFlags;
  /** Optional secret-scan rule extensions/suppressions. */
  scanOptions?: SecretScanOptions;
  /**
   * EV3/EV4 — render the egress disclosure + preview and return the user's
   * explicit consent. Called before any bytes leave; the composition root may
   * remember a "yes" for the run (still printing the file list per UN2).
   */
  confirmEgress: (plan: EgressPlan, destination: EgressDestination) => Promise<boolean>;
  /** EV2 — show the proposed merge as a diff; return explicit approval. */
  approveMerge: (
    slot: string,
    proposedText: string,
    candidates: readonly CandidateText[],
  ) => Promise<boolean>;
  /** C3's deterministic resolver — the fallback for every non-merge outcome. */
  fallback: ContradictionResolver;
  /** Layer-4 sink for non-fatal fallback notices (UN1/UN3). */
  warn: (message: string) => void;
}

/** Builds the egress inputs for a contradiction: each candidate's text, slot-keyed. */
function egressInputsFor(contradiction: Contradiction): EgressFileInput[] {
  return contradiction.candidates.map((candidate) => ({
    path: candidate.path,
    slot: contradiction.slot,
    content: candidate.text,
  }));
}

/**
 * Composes the AI-assist `ContradictionResolver`. The returned function is
 * called once per contradiction by the `init` use case; it gates the egress,
 * asks the backend, and returns a `Resolution` (a `merge`, an EV1 agreement
 * collapsed to `choose`, or — for any block/decline/error — whatever the
 * deterministic fallback decides).
 */
export function buildAiResolver(deps: AiResolverDeps): ContradictionResolver {
  return async (contradiction: Contradiction): Promise<Resolution> => {
    // 1. C5 egress policy on the candidate bytes — BEFORE any backend call.
    const plan = planEgress(egressInputsFor(contradiction), deps.egressFlags, deps.scanOptions);
    if (plan.decision === 'blocked') {
      // Show the full actionable block (file:line:rule + remedies), then fall
      // back deterministically for this slot — nothing was sent.
      deps.warn(
        `${renderEgressBlock(plan).trimEnd()}\n` +
          `(slot "${contradiction.slot}" resolved with the deterministic resolver instead.)`,
      );
      return deps.fallback(contradiction);
    }

    // 2. Explicit egress consent (EV3) — the disclosure/preview is rendered by
    //    the layer-4 callback; absent consent, nothing is sent (UN3).
    const consented = await deps.confirmEgress(plan, deps.backend.destination);
    if (!consented) {
      deps.warn(
        `egress consent declined for "${contradiction.slot}"; using the deterministic resolver.`,
      );
      return deps.fallback(contradiction);
    }

    // 3. Build the request from the POST-redaction, included bytes only.
    const includedByPath = new Map(plan.files.filter((f) => f.included).map((f) => [f.path, f]));
    const requestCandidates = contradiction.candidates
      .filter((candidate) => includedByPath.has(candidate.path))
      .map((candidate) => ({
        providerId: candidate.providerId,
        path: candidate.path,
        text: includedByPath.get(candidate.path)!.content,
      }));
    if (requestCandidates.length === 0) {
      // Policy withheld everything — nothing to reason over; stay deterministic.
      deps.warn(
        `no egress-eligible candidates for "${contradiction.slot}"; using the deterministic resolver.`,
      );
      return deps.fallback(contradiction);
    }

    // 4. Single bounded model call; any failure is a deterministic fallback (UN1).
    let proposal: AssistProposal;
    try {
      proposal = await deps.backend.proposeResolution({
        slot: contradiction.slot,
        candidates: requestCandidates,
      });
    } catch (err) {
      deps.warn(
        `assist backend failed for "${contradiction.slot}" ` +
          `(${err instanceof Error ? err.message : String(err)}); using the deterministic resolver.`,
      );
      return deps.fallback(contradiction);
    }

    // 5. EV1 — semantically equivalent: agree silently, no prompt for the slot.
    if (proposal.kind === 'equivalent') {
      return { kind: 'choose', index: 0 };
    }

    // 6. EV2 — proposed merge needs explicit human approval; decline → fallback.
    const approved = await deps.approveMerge(
      contradiction.slot,
      proposal.text,
      contradiction.candidates,
    );
    if (!approved) {
      return deps.fallback(contradiction);
    }
    return { kind: 'merge', text: proposal.text };
  };
}
