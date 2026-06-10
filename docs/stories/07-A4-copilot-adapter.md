# A4 — GitHub Copilot adapter

**Type:** Adapter
**Depends on:** F1, F3
**Blocks:** C1, C2, C3
**Labels:** `enhancement`, `adapter`

## Context
Copilot is the most divergent of the four targets: no nested instruction files (it has a flat `.github/instructions/<name>.instructions.md` model with `applyTo` frontmatter globs), no skills concept, and a coding-agent-only hook surface at `.github/hooks/*.json`. Lossy translation is unavoidable here — the adapter must surface the losses cleanly.

## Requirements (EARS)

- **U1.** The adapter shall register with `id: 'copilot'`.
- **EV1.** When the IR contains a root `Instruction`, the adapter shall emit it as `.github/copilot-instructions.md`.
- **EV2.** When the IR contains a nested or scoped `Instruction`, the adapter shall emit it as `.github/instructions/<flatname>.instructions.md` with `applyTo` frontmatter set to the scope glob.
- **EV3.** When the IR contains `Hook` entries that target events Copilot's coding-agent supports, the adapter shall emit `.github/hooks/<event>.<name>.json`.
- **OPT1.** Where the IR contains `Skill` entries, the adapter shall emit warning `HH-W002` for each, and emit nothing.
- **OPT2.** Where a `scope` glob uses syntax outside Copilot's `applyTo` capabilities (e.g., regex, brace expansion), the adapter shall emit warning `HH-W001` and downgrade to the closest expressible glob.
- **UN1.** If two nested `AGENTS.md` files would flatten to the same `<flatname>.instructions.md`, then the adapter shall fail before emit, naming both source paths.

## Acceptance criteria

- [ ] Adapter at `src/adapters/copilot.ts`.
- [ ] Tests cover: root emit; nested → flat with `applyTo`; skill → warning + no emit; lossy glob warning; collision detection.
- [ ] Lossy-translation test asserts both the warning code *and* the downgraded glob shape.

## Out of scope
- Detecting which hook events Copilot's coding-agent currently supports — bake the list as a constant; revisit when Copilot adds events.
