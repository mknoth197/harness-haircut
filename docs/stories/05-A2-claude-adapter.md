# A2 — Claude Code adapter

**Type:** Adapter
**Depends on:** F1, F3
**Blocks:** C1, C2, C3
**Labels:** `enhancement`, `adapter`

## Context
Claude Code does not yet read `AGENTS.md` natively (tracked upstream as `anthropics/claude-code#6235`). Until that lands, the adapter projects instructions to `CLAUDE.md`. Skills go to `.claude/skills/`, hooks go inside `.claude/settings.json` under the `hooks` key, with all other keys preserved.

## Requirements (EARS)

- **U1.** The adapter shall register with `id: 'claude'`.
- **EV1.** When the IR contains a root `Instruction`, the adapter shall emit it as `CLAUDE.md` with a SignedSource header.
- **EV2.** When the IR contains nested `Instruction` entries, the adapter shall concatenate them under scoped headings inside the root `CLAUDE.md` (Claude does not support nested files in v1).
- **EV3.** When the IR contains `Skill` entries, the adapter shall emit them as `.claude/skills/<name>/SKILL.md`.
- **EV4.** When the IR contains `Hook` entries, the adapter shall write the `hooks` key inside `.claude/settings.json`, leaving all other top-level keys untouched (mode `merge-key`).
- **OPT1.** Where the canonical instruction has a `scope` glob that cannot be expressed in a Claude heading (e.g., regex), the adapter shall emit warning `HH-W001`.
- **UN1.** If the existing `.claude/settings.json` is malformed JSON, then the adapter shall fail and report the error (do not silently overwrite).

## Acceptance criteria

- [ ] Adapter at `src/adapters/claude.ts`.
- [ ] Tests cover: root + nested instruction concatenation; skill emit; settings.json merge preserves user theme/keybindings; lossy glob warning; malformed settings.json refuses overwrite.
- [ ] Fixture-based round-trip test where reasonable (note: nested → flattened is intentionally lossy and tracked via warning).

## Out of scope
- Switching to native `AGENTS.md` once `claude-code#6235` ships — that's a future story.
