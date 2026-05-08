# F3 — Provider adapter interface and registry

**Type:** Foundational
**Depends on:** F0, F1
**Blocks:** A1, A2, A3, A4, C1, C2, C3
**Labels:** `enhancement`, `foundation`

## Context
[PRD §12](../PRD.md) establishes adapters as the only place provider-specific logic lives. This story defines the `ProviderAdapter` contract, the warning catalogue (`HH-Wxxx` codes), the `EmittedFile` type, and the registry that maps provider IDs to adapters.

## Requirements (EARS)

- **U1.** The package shall export a `ProviderAdapter` interface with `id`, `project(ir, ctx)`, and `detectExisting(snapshot)`.
- **U2.** The package shall export an `EmittedFile` type with at least `path`, `body`, `mode` (`overwrite` | `merge-key`), and `mergeKey?` for merge-key emits.
- **U3.** The package shall export a `Warning` type `{ code, severity, message, canonicalPath?, providerId? }` and a registry of warning codes.
- **U4.** The registry shall expose `getAdapter(id)` and `listAdapters()`.
- **EV1.** When an adapter cannot losslessly translate an IR element, it shall emit a `Warning` with severity `'warn'` and the appropriate `HH-Wxxx` code, and continue with the closest non-lossy approximation.
- **OPT1.** Where an adapter is configured as disabled in `harness-haircut.config.json`, the registry shall exclude it from `listAdapters()`.
- **UN1.** If two adapters register the same `id`, then registry initialization shall throw before any command runs.

## Acceptance criteria

- [ ] Interface and types in `src/adapter.ts`.
- [ ] Registry in `src/adapter-registry.ts`.
- [ ] Warning code catalogue stub at `src/warnings.ts` with at least `HH-W001` (lossy glob), `HH-W002` (skill emitted to skill-less provider), `HH-W003` (hook event has no target mapping), `HH-W010` (unknown attachment).
- [ ] Tests verify: registry rejects duplicate IDs; disabled adapter is filtered out; warnings serialize cleanly to JSON for `--json` output.

## Out of scope
- Concrete adapters (covered by A1–A4).
- Emitter / writer (covered by C2).
