# A1 — OpenAI Codex adapter

**Type:** Adapter
**Depends on:** F1, F3
**Blocks:** C1, C2, C3 (need at least one adapter to make commands meaningful)
**Labels:** `enhancement`, `adapter`

## Context
Codex consumes `AGENTS.md` natively (root + nested) per [PRD §5](../PRD.md). This is the simplest adapter — it's almost a pass-through for instructions — and the right place to validate the adapter interface end-to-end before A2/A3/A4.

## Requirements (EARS)

- **U1.** The adapter shall register with `id: 'codex'`.
- **EV1.** When the IR contains `Instruction` entries, the adapter shall emit them verbatim as `AGENTS.md` files at their original paths (root and nested).
- **EV2.** When the IR contains `Skill` entries, the adapter shall emit them as `.codex/skills/<name>/SKILL.md` (and copy any sibling files in the canonical skill folder).
- **EV3.** When the IR contains `Hook` entries, the adapter shall emit a `[hooks]` table inside `.codex/config.toml`, merging with any existing non-hook keys per [PRD §10](../PRD.md).
- **EV4.** When `detectExisting` is called against a repo with `AGENTS.md` already present, it shall return a snapshot with `instructions` and the file paths it owns.
- **UN1.** If a hook's `event` does not map to a Codex-supported event, then the adapter shall emit warning `HH-W003` and skip that hook.

## Acceptance criteria

- [ ] Adapter at `src/adapters/codex.ts`.
- [ ] Unit tests cover: pass-through `AGENTS.md`, skill emit, hook merge into existing `.codex/config.toml` preserving foreign keys, hook event unmapped → warning.
- [ ] Fixture-based round-trip test: IR → adapter → emitted files → re-parse → IR equivalence.

## Out of scope
- Writing files to disk (the adapter only returns `EmittedFile[]`; C2 writes them).
