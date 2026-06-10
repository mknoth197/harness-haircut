# A3 — Google Gemini CLI adapter

**Type:** Adapter
**Depends on:** F1, F3
**Blocks:** C1, C2, C3
**Labels:** `enhancement`, `adapter`

## Context
Gemini CLI reads instructions from `GEMINI.md` (or a path declared via `context.fileName` in `.gemini/settings.json`). Skills live under `.gemini/skills/`, hooks inside `.gemini/settings.json` under the `hooks` key.

## Requirements (EARS)

- **U1.** The adapter shall register with `id: 'gemini'`.
- **EV1.** When the IR contains a root `Instruction`, the adapter shall emit `GEMINI.md` with a SignedSource header.
- **EV2.** When the IR contains nested `Instruction` entries, the adapter shall concatenate them under scoped headings in the root `GEMINI.md`.
- **EV3.** When the IR contains `Skill` entries, the adapter shall emit them as `.gemini/skills/<name>/SKILL.md`.
- **EV4.** When the IR contains `Hook` entries, the adapter shall write the `hooks` key inside `.gemini/settings.json`, preserving all other top-level keys.
- **OPT1.** Where the user's `.gemini/settings.json` already declares a non-default `context.fileName`, the adapter shall emit instructions to that path instead of `GEMINI.md` and surface an info-level note.
- **UN1.** If the existing `.gemini/settings.json` is malformed JSON, then the adapter shall fail and report the error.

## Acceptance criteria

- [ ] Adapter at `src/adapters/gemini.ts`.
- [ ] Tests cover: default `GEMINI.md` emit; honoring custom `context.fileName`; skill emit; settings.json merge; malformed settings refusal.

## Out of scope
- Honoring `~/.gemini/` user-scope settings (single-repo scope, see PRD non-goals).
