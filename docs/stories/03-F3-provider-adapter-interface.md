# F3 — Provider adapter interface and registry

**Type:** Foundational
**Depends on:** F0, F1
**Blocks:** A1, A2, A3, A4, C1, C2, C3
**Labels:** `enhancement`, `foundation`

## Context
[PRD §12](../PRD.md) establishes adapters as the only place provider-specific logic lives. This story defines the `ProviderAdapter` contract, the warning catalogue (`HH-Wxxx` codes), the `EmittedFile` type, and the registry that maps provider IDs to adapters. The verified [provider matrix](../research/provider-matrix.md) adds a requirement v0.2 lacked: several surfaces are **native no-ops** (e.g. `.agents/skills/` for Codex/Gemini/Copilot), and the interface must represent "nothing emitted, by design" distinctly from "emitted" and "skipped with warning" so `audit` and `doctor` can report them honestly.

## Requirements (EARS)

- **U1.** The package shall export a `ProviderAdapter` interface with `id`, `project(ir, ctx)`, and `detectExisting(snapshot)`, defined in the entities layer; concrete adapters live in `src/adapters/` (layer 3).
- **U2.** The package shall export an `EmittedFile` type with at least `path`, `body`, `mode` (`overwrite` | `merge-key`), and `mergeKey?` for merge-key emits.
- **U3.** `project()` shall return a `Projection` containing `files: EmittedFile[]`, `warnings: Warning[]`, and a per-surface summary mapping each of `instructions` | `skills` | `hooks` to `'emitted' | 'merged' | 'native' | 'skipped'`.
- **U4.** The package shall export a `Warning` type `{ code, severity, message, canonicalPath?, providerId? }` and a registry of warning codes.
- **U5.** The registry shall expose `getAdapter(id)` and `listAdapters()`.
- **U6.** The package shall export per-adapter hook event mapping tables `Record<HookEvent, string | null>` (null = unmappable → `HH-W003`), so mappings are data, not branching logic.
- **EV1.** When an adapter cannot losslessly translate an IR element, it shall emit a `Warning` with severity `'warn'` and the appropriate `HH-Wxxx` code, and continue with the closest non-lossy approximation.
- **OPT1.** Where an adapter is configured as disabled in `harness-haircut.config.json`, the registry shall exclude it from `listAdapters()`.
- **UN1.** If two adapters register the same `id`, then registry initialization shall throw before any command runs.

## Acceptance criteria

- [ ] Interface and types in `src/entities/adapter.ts`; registry in `src/adapters/registry.ts`.
- [ ] Warning code catalogue at `src/entities/warnings.ts` *(updated for v0.3 — `HH-W002` "skill-less provider" is retired; every v1 provider consumes skills)*:
  - `HH-W001` — lossy glob downgrade
  - `HH-W003` — hook event unmappable for a provider
  - `HH-W004` — provider size cap exceeded (e.g. Codex 32 KiB AGENTS.md chain)
  - `HH-W005` — duplicate hook sources detected in provider config
  - `HH-W006` — deprecated provider config key detected (e.g. Gemini flat `contextFileName`)
  - `HH-W010` — unknown attachment under `.agents/`
  - `HH-W011` — frontmatter in AGENTS.md (leaks verbatim into prompts)
- [ ] Tests verify: registry rejects duplicate IDs; disabled adapter filtered out; per-surface summary values round-trip to `--json`; event-mapping tables are total over the canonical `HookEvent` enum (every event maps to a string or an explicit null for every adapter).
- [ ] Warning catalogue doc pages at `docs/warnings/HH-Wxxx.md` (one per code) so warning output can link to an explanation.

## Out of scope
- Concrete adapters (covered by A1–A4).
- Emitter / writer (covered by C2).
