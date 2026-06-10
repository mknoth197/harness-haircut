/**
 * Contradiction model for `init` (C3, #13) — layer 1 (entities): pure data,
 * no I/O, no imports from outer layers.
 *
 * `init` onboards a NON-canonical repo: it reads each provider's existing
 * instruction/skill files, discovers the *candidate* canonical text each one
 * carries, and where two providers disagree on the same logical slot it
 * surfaces a `Contradiction` for the user to resolve. The use case (layer 2)
 * finds contradictions and applies resolutions; the composition root
 * (layer 4) supplies the interactive resolver (a `node:readline`
 * numbered-choice prompt) — this module only defines the shapes both share.
 *
 * Scope (PRD §4 use case 1, C3 EARS): the primary contradiction surface is
 * **root instructions** (the text that becomes canonical `AGENTS.md`), plus
 * **skills** carried over by name. Provider hook configs are NOT
 * reverse-engineered into canonical hooks in v1 — their formats are lossy to
 * invert — so they never produce a contradiction (see `InitReport.notes`).
 */
import type { ProviderId } from './adapter.js';

/**
 * One candidate answer for a contradiction slot: the text a single provider's
 * file contributes. `text` is the ORIGINAL text to write if chosen (the
 * stripped-of-shim-header body for instruction files); `normalizedText` is the
 * comparison key (trailing whitespace trimmed, single trailing newline) used
 * to decide whether two candidates actually agree.
 */
export interface CandidateText {
  /** The provider whose file contributed this candidate. */
  providerId: ProviderId;
  /** Repo-relative POSIX path of the source file. */
  path: string;
  /** Original text to write verbatim when this candidate is chosen. */
  text: string;
  /** Normalized text used only for byte-equality comparison between candidates. */
  normalizedText: string;
}

/**
 * A logical slot whose candidates disagree. `slot` is `'root-instructions'`
 * for the canonical `AGENTS.md` text, or `'skill:<name>'` for a named skill
 * whose same-name copies have differing bodies. `candidates` is sorted by
 * provider id for deterministic prompts; `plusSkip` is always true in v1 — the
 * resolver may always choose to skip the slot (write nothing).
 */
export interface Contradiction {
  slot: string;
  candidates: CandidateText[];
  /** Whether "skip / write blank" is an offered option (always true in v1). */
  plusSkip: true;
}

/**
 * The user's answer to one contradiction. `{ kind: 'choose', index }` selects
 * `candidates[index]`; `{ kind: 'skip' }` writes nothing for the slot;
 * `{ kind: 'unresolved' }` signals the resolver could not decide (e.g.
 * `--non-interactive`), which fails the run (OPT1, exit 1).
 */
export type Resolution =
  | { kind: 'choose'; index: number }
  | { kind: 'skip' }
  | { kind: 'unresolved' };

/** Injected by layer 4; the use case awaits one resolution per contradiction. */
export type ContradictionResolver = (contradiction: Contradiction) => Promise<Resolution>;
