import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLAUDE_EVENT_MAP,
  CODEX_EVENT_MAP,
  COPILOT_EVENT_MAP,
  GEMINI_EVENT_MAP,
  EVENT_MAPS,
  HOOK_EVENTS,
} from '../../dist/index.js';
import type { HookEventMap } from '../../dist/index.js';

const TABLES: ReadonlyArray<[string, HookEventMap]> = [
  ['claude', CLAUDE_EVENT_MAP],
  ['codex', CODEX_EVENT_MAP],
  ['gemini', GEMINI_EVENT_MAP],
  ['copilot', COPILOT_EVENT_MAP],
];

describe('event mapping tables', () => {
  it('canonical enum has exactly the nine v0.3 events', () => {
    assert.deepEqual([...HOOK_EVENTS].sort(), [
      'post-tool-use',
      'pre-compact',
      'pre-tool-use',
      'session-end',
      'session-start',
      'stop',
      'subagent-start',
      'subagent-stop',
      'user-prompt-submit',
    ]);
  });

  for (const [provider, table] of TABLES) {
    it(`${provider} table is total over the canonical enum`, () => {
      assert.deepEqual(Object.keys(table).sort(), [...HOOK_EVENTS].sort());
      for (const event of HOOK_EVENTS) {
        const mapped = table[event];
        assert.equal(
          typeof mapped === 'string' || mapped === null,
          true,
          `${provider}[${event}] must be a string or an explicit null`,
        );
      }
    });
  }

  it('EVENT_MAPS indexes all four provider tables', () => {
    assert.deepEqual(Object.keys(EVENT_MAPS).sort(), ['claude', 'codex', 'copilot', 'gemini']);
    assert.equal(EVENT_MAPS.gemini, GEMINI_EVENT_MAP);
  });
});

describe('claude event names (PascalCase, all nine mappable)', () => {
  it('maps the full enum to PascalCase names including SessionEnd', () => {
    assert.deepEqual(CLAUDE_EVENT_MAP, {
      'session-start': 'SessionStart',
      'session-end': 'SessionEnd',
      'user-prompt-submit': 'UserPromptSubmit',
      'pre-tool-use': 'PreToolUse',
      'post-tool-use': 'PostToolUse',
      stop: 'Stop',
      'subagent-start': 'SubagentStart',
      'subagent-stop': 'SubagentStop',
      'pre-compact': 'PreCompact',
    });
  });
});

describe('codex event names (PascalCase, no SessionEnd)', () => {
  it('maps session-end to null — Codex has no such event', () => {
    assert.equal(CODEX_EVENT_MAP['session-end'], null);
  });

  it('maps the remaining events to PascalCase names', () => {
    assert.equal(CODEX_EVENT_MAP['session-start'], 'SessionStart');
    assert.equal(CODEX_EVENT_MAP['user-prompt-submit'], 'UserPromptSubmit');
    assert.equal(CODEX_EVENT_MAP['pre-tool-use'], 'PreToolUse');
    assert.equal(CODEX_EVENT_MAP['post-tool-use'], 'PostToolUse');
    assert.equal(CODEX_EVENT_MAP.stop, 'Stop');
    assert.equal(CODEX_EVENT_MAP['subagent-start'], 'SubagentStart');
    assert.equal(CODEX_EVENT_MAP['subagent-stop'], 'SubagentStop');
    assert.equal(CODEX_EVENT_MAP['pre-compact'], 'PreCompact');
  });
});

describe('gemini event names (Before/After taxonomy)', () => {
  it('maps tool and agent events to Gemini names', () => {
    assert.equal(GEMINI_EVENT_MAP['pre-tool-use'], 'BeforeTool');
    assert.equal(GEMINI_EVENT_MAP['post-tool-use'], 'AfterTool');
    assert.equal(GEMINI_EVENT_MAP['user-prompt-submit'], 'BeforeAgent');
    assert.equal(GEMINI_EVENT_MAP.stop, 'AfterAgent');
    assert.equal(GEMINI_EVENT_MAP['pre-compact'], 'PreCompress');
    assert.equal(GEMINI_EVENT_MAP['session-start'], 'SessionStart');
    assert.equal(GEMINI_EVENT_MAP['session-end'], 'SessionEnd');
  });

  it('maps subagent events to null — Gemini has no subagent hooks', () => {
    assert.equal(GEMINI_EVENT_MAP['subagent-start'], null);
    assert.equal(GEMINI_EVENT_MAP['subagent-stop'], null);
  });
});

describe('copilot event names (camelCase)', () => {
  it('maps the full enum to camelCase names including agentStop', () => {
    assert.deepEqual(COPILOT_EVENT_MAP, {
      'session-start': 'sessionStart',
      'session-end': 'sessionEnd',
      'user-prompt-submit': 'userPromptSubmitted',
      'pre-tool-use': 'preToolUse',
      'post-tool-use': 'postToolUse',
      stop: 'agentStop',
      'subagent-start': 'subagentStart',
      'subagent-stop': 'subagentStop',
      'pre-compact': 'preCompact',
    });
  });
});
