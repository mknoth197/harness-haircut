/**
 * Per-provider hook event mapping tables — F3 U6, PRD §8.
 * Mappings are data, not branching logic: every table is total over the
 * canonical 9-event enum; `null` marks an event the provider lacks
 * (adapters emit HH-W003 and skip it). Names are taken verbatim from the
 * verified provider matrix (docs/research/provider-matrix.md, 2026-06-10).
 */
import type { ProviderId } from '../entities/adapter.js';
import type { HookEvent } from '../entities/ir.js';

export type HookEventMap = Readonly<Record<HookEvent, string | null>>;

/** Claude Code: PascalCase, ~30-event taxonomy — all nine canonical events exist. */
export const CLAUDE_EVENT_MAP: HookEventMap = {
  'session-start': 'SessionStart',
  'session-end': 'SessionEnd',
  'user-prompt-submit': 'UserPromptSubmit',
  'pre-tool-use': 'PreToolUse',
  'post-tool-use': 'PostToolUse',
  stop: 'Stop',
  'subagent-start': 'SubagentStart',
  'subagent-stop': 'SubagentStop',
  'pre-compact': 'PreCompact',
};

/** Codex: PascalCase, 10-event taxonomy — no SessionEnd event. */
export const CODEX_EVENT_MAP: HookEventMap = {
  'session-start': 'SessionStart',
  'session-end': null,
  'user-prompt-submit': 'UserPromptSubmit',
  'pre-tool-use': 'PreToolUse',
  'post-tool-use': 'PostToolUse',
  stop: 'Stop',
  'subagent-start': 'SubagentStart',
  'subagent-stop': 'SubagentStop',
  'pre-compact': 'PreCompact',
};

/**
 * Gemini CLI: Before/After naming. `user-prompt-submit` → `BeforeAgent` is
 * approximate (fires when the agent loop starts processing a prompt, A3
 * EV4); no subagent events exist.
 */
export const GEMINI_EVENT_MAP: HookEventMap = {
  'session-start': 'SessionStart',
  'session-end': 'SessionEnd',
  'user-prompt-submit': 'BeforeAgent',
  'pre-tool-use': 'BeforeTool',
  'post-tool-use': 'AfterTool',
  stop: 'AfterAgent',
  'subagent-start': null,
  'subagent-stop': null,
  'pre-compact': 'PreCompress',
};

/** Copilot: camelCase — all nine canonical events exist (`stop` is `agentStop`). */
export const COPILOT_EVENT_MAP: HookEventMap = {
  'session-start': 'sessionStart',
  'session-end': 'sessionEnd',
  'user-prompt-submit': 'userPromptSubmitted',
  'pre-tool-use': 'preToolUse',
  'post-tool-use': 'postToolUse',
  stop: 'agentStop',
  'subagent-start': 'subagentStart',
  'subagent-stop': 'subagentStop',
  'pre-compact': 'preCompact',
};

export const EVENT_MAPS: Readonly<Record<ProviderId, HookEventMap>> = {
  claude: CLAUDE_EVENT_MAP,
  codex: CODEX_EVENT_MAP,
  gemini: GEMINI_EVENT_MAP,
  copilot: COPILOT_EVENT_MAP,
};
