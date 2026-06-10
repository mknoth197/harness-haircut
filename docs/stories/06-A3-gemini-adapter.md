# A3 — Google Gemini CLI adapter

**Type:** Adapter
**Depends on:** F1, F3
**Blocks:** C1, C2, C3
**Labels:** `enhancement`, `adapter`

## Context
Per the verified [provider matrix](../research/provider-matrix.md): Gemini CLI's default context file is hard-coded `GEMINI.md`; AGENTS.md-by-default was closed as not-planned. The clean projection is setting **`context.fileName: ["AGENTS.md", "GEMINI.md"]`** (nested v2 key, replaces the default — array keeps GEMINI.md loading) in `.gemini/settings.json`. Skills are a **no-op**: the `.agents/skills/` alias is native and takes precedence over `.gemini/skills/`. Hooks live under the `hooks` key in `.gemini/settings.json` with **Gemini-specific event names** (BeforeTool/AfterTool/…), so projection is an event-name mapping, not a copy.

⚠️ **Strategic note (PRD §14):** Gemini Code Assist consumer auth sunsets 2026-06-18 (enterprise + API-key/Vertex continue; OSS CLI keeps releasing). Adapter ships as specced; re-validate against Antigravity CLI before v1.0.

## Requirements (EARS)

- **U1.** The adapter shall register with `id: 'gemini'`.
- **EV1.** When the IR contains `Instruction` entries, the adapter shall write `context.fileName: ["AGENTS.md", "GEMINI.md"]` into `.gemini/settings.json` (mode `merge-key`) instead of emitting a `GEMINI.md` content copy.
- **EV2.** When the user config sets `geminiMode: "shim"` (in `harness-haircut.config.json`), the adapter shall instead emit a `GEMINI.md` whose first line is the import `@AGENTS.md` (Gemini import syntax, maxDepth 5).
- **EV3.** When the IR contains `Skill` entries, the adapter shall emit nothing and report the surface as `native` (`.agents/skills/` alias, precedence over `.gemini/skills/`).
- **EV4.** When the IR contains `Hook` entries, the adapter shall write the `hooks` key in `.gemini/settings.json` (mode `merge-key`), mapping canonical events to Gemini's taxonomy (`pre-tool-use` → `BeforeTool`, `post-tool-use` → `AfterTool`, `session-start` → `SessionStart`, `session-end` → `SessionEnd`, `pre-compact` → `PreCompress`, `stop` → `AfterAgent`, …) with timeout values converted to **milliseconds**.
- **EV5.** When an existing `.gemini/settings.json` already sets `context.fileName`, the adapter shall merge `"AGENTS.md"` into the existing value (string → array promotion) rather than clobbering user entries, and preserve all other settings keys (`mcpServers`, `tools.*`, `telemetry.*`, …).
- **OPT1.** Where a canonical hook event has no Gemini equivalent (e.g. `subagent-start` pre-mapping table), the adapter shall emit warning `HH-W003` and skip it.
- **UN1.** If the existing `.gemini/settings.json` is malformed JSON, then the adapter shall fail and report the error.
- **UN2.** If the legacy flat `contextFileName` (v1 schema) key is present, then the adapter shall warn (`HH-W006` — deprecated provider config detected) and write only the nested v2 key.

## Acceptance criteria

- [ ] Adapter at `src/adapters/gemini.ts`.
- [ ] Tests cover: settings-mode `context.fileName` write + array merge with existing values; shim-mode `GEMINI.md` emit; skills native no-op; hook event mapping incl. ms conversion; settings merge preserves foreign keys; malformed settings refusal; legacy `contextFileName` warning.
- [ ] Projection summary distinguishes `native` / `emitted` / `merged`.

## Out of scope
- Antigravity CLI support (v2 candidate per PRD §14).
- `~/.gemini/` user-scope settings (single-repo scope, see PRD non-goals).
- Gemini extensions (`.gemini/extensions/`) and custom commands (`.gemini/commands/*.toml`) — not part of the three v1 layers.
