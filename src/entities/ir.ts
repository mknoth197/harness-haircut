/**
 * Canonical intermediate representation (IR) — F1 (#4), PRD §8/§12.
 * Layer 1 (entities): pure data, no I/O, no imports from outer layers.
 */

/**
 * Canonical hook event enum (PRD §8 v0.3). A mappable superset of the four
 * providers' taxonomies — not every provider has every event; gaps surface
 * as HH-W003 per provider. `pre-commit` is deliberately absent: no provider
 * has an agent-hook event for it (git-level enforcement is I1's job).
 */
export type HookEvent =
  | 'session-start'
  | 'session-end'
  | 'user-prompt-submit'
  | 'pre-tool-use'
  | 'post-tool-use'
  | 'stop'
  | 'subagent-start'
  | 'subagent-stop'
  | 'pre-compact';

export const HOOK_EVENTS: readonly HookEvent[] = [
  'session-start',
  'session-end',
  'user-prompt-submit',
  'pre-tool-use',
  'post-tool-use',
  'stop',
  'subagent-start',
  'subagent-stop',
  'pre-compact',
];

export function isHookEvent(value: string): value is HookEvent {
  return (HOOK_EVENTS as readonly string[]).includes(value);
}

/** An opaque file carried through the IR verbatim (skill sibling files, unknown `.agents/` files). */
export interface Attachment {
  /** Repo-relative POSIX path. */
  path: string;
  content: string;
}

export interface Instruction {
  /** Repo-relative POSIX path of the source file. */
  path: string;
  /**
   * Glob the instruction applies to. For a root `AGENTS.md` this is `**`;
   * for a nested `<dir>/AGENTS.md` it is `<dir>/**`; for an
   * `.agents/instructions/*.md` fragment it comes from `scope:` frontmatter.
   */
  scope: string;
  body: string;
}

export interface Skill {
  /** From SKILL.md frontmatter (Agent Skills common core). */
  name: string;
  /** From SKILL.md frontmatter (Agent Skills common core). */
  description: string;
  /** Repo-relative POSIX path of the SKILL.md entrypoint. */
  path: string;
  /** Post-frontmatter markdown of SKILL.md. */
  body: string;
  /** Sibling files in the skill folder (scripts/, references/, assets/, …). */
  files: Attachment[];
}

export interface Hook {
  event: HookEvent;
  /** The `<name>` segment of `.agents/hooks/<event>.<name>.<ext>`. */
  name: string;
  /** Repo-relative POSIX path of the source file. */
  path: string;
  /** The file body. harness-haircut never executes it; adapters only project it. */
  script: string;
}

export interface IR {
  instructions: Instruction[];
  skills: Skill[];
  hooks: Hook[];
  /** Unrecognized `.agents/` files, carried opaquely (F1 EV5, warning HH-W010). */
  attachments: Attachment[];
}
