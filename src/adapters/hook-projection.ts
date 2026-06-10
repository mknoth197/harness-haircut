/**
 * Shared hook-projection helpers for the A1–A4 adapters.
 *
 * Grouping is pure data transformation: canonical hooks are bucketed under
 * provider-native event names via the adapter's event map; events the
 * provider lacks produce one `HH-W003` warning per hook and are skipped for
 * that provider only (PRD §8, F3 EV1).
 *
 * Commands always reference the canonical script path verbatim
 * (`.agents/hooks/<event>.<name>.<ext>`) instead of inlining the script
 * body: Codex trust-hashes each hook definition per user (PRD §14), and a
 * thin stable command means editing the script never churns the definition.
 * The same convention is used for every provider so a hook is invoked
 * identically everywhere.
 */
import type { Hook } from '../entities/ir.js';
import { HOOK_EVENTS } from '../entities/ir.js';
import type { Warning } from '../entities/warnings.js';
import type { HookEventMap } from './event-maps.js';

export interface HookGrouping {
  /**
   * Provider event name → canonical hooks, keyed in canonical-enum order,
   * hooks within an event sorted by path (deterministic emit).
   */
  byEvent: Map<string, Hook[]>;
  /** One HH-W003 warning per hook whose event the provider lacks. */
  warnings: Warning[];
}

export function groupHooksByProviderEvent(
  hooks: readonly Hook[],
  map: HookEventMap,
  providerId: string,
): HookGrouping {
  const byEvent = new Map<string, Hook[]>();
  const warnings: Warning[] = [];
  for (const event of HOOK_EVENTS) {
    const matching = hooks
      .filter((hook) => hook.event === event)
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    if (matching.length === 0) {
      continue;
    }
    const mapped = map[event];
    if (mapped === null) {
      for (const hook of matching) {
        warnings.push({
          code: 'HH-W003',
          severity: 'warn',
          message:
            `hook event "${event}" has no ${providerId} equivalent; ` +
            `${hook.path} is not projected for ${providerId}`,
          canonicalPath: hook.path,
          providerId,
        });
      }
      continue;
    }
    byEvent.set(mapped, matching);
  }
  return { byEvent, warnings };
}

/**
 * Builds the `{"<Event>": [{"hooks": [entry…]}]}` object shared by the
 * Claude / Codex / Gemini hook schemas: one match-all group per event
 * carrying all of that event's handlers. The `matcher` key is deliberately
 * omitted — an absent matcher means "match all" across all four provider
 * schemas, whereas the `"*"` value is undocumented for Gemini and Codex
 * (provider matrix). `entryFor` supplies the provider-specific handler
 * shape.
 */
export function buildMatcherHookGroups(
  byEvent: ReadonlyMap<string, readonly Hook[]>,
  entryFor: (hook: Hook) => Record<string, unknown>,
): Record<string, unknown> {
  const groups: Record<string, unknown> = {};
  for (const [event, eventHooks] of byEvent) {
    groups[event] = [{ hooks: eventHooks.map(entryFor) }];
  }
  return groups;
}
