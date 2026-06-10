# A1 — OpenAI Codex adapter

**Type:** Adapter
**Depends on:** F1, F3
**Blocks:** C1, C2, C3 (need at least one adapter to make commands meaningful)
**Labels:** `enhancement`, `adapter`

## Context
Codex consumes `AGENTS.md` natively (root→cwd concatenation, 32 KiB combined cap) and — per the verified [provider matrix](../research/provider-matrix.md) — **also discovers canonical `.agents/skills/` natively** (`.codex/skills/` is legacy). That leaves hooks as the only real projection surface: `.codex/hooks.json` (GA 2026-05-14), with per-user hash-pinned trust review. This is the simplest adapter and the right place to validate the adapter interface end-to-end before A2/A3/A4.

## Requirements (EARS)

- **U1.** The adapter shall register with `id: 'codex'`.
- **U2.** The adapter shall emit **no instruction files** (native `AGENTS.md`) and **no skill files** (native `.agents/skills/` discovery) — both surfaces are no-ops that the adapter reports as `native` in its projection summary.
- **EV1.** When the combined size of root + nested `AGENTS.md` content exceeds 32 KiB (Codex's default `project_doc_max_bytes`), the adapter shall emit warning `HH-W004` (provider size cap exceeded — content past the cap is silently dropped by Codex). Note: the check is an **over-approximation** — it sums every `AGENTS.md` body in the repo, while Codex applies the cap per root→cwd chain, so a repo with many parallel nested files can warn even though no single chain exceeds the cap. The warning message states this.
- **EV2.** When the IR contains `Hook` entries with events mappable to Codex's taxonomy (SessionStart, SubagentStart/Stop, PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact, UserPromptSubmit, Stop), the adapter shall emit `.codex/hooks.json` with schema `{"hooks": {"<Event>": [{"matcher", "hooks": [{"type": "command", ...}]}]}}`.
- **EV3.** When emitting a hook, the adapter shall emit a stable thin command that invokes the canonical hook script at its repo path (e.g. `.agents/hooks/<event>.<name>.sh`) rather than inlining the body — Codex trust-hashes each hook definition and re-prompts every user when it changes.
- **EV4.** When `detectExisting` is called against a repo with `AGENTS.md`, `.agents/skills/`, `.codex/hooks.json`, or a `[hooks]` table in `.codex/config.toml` present, it shall return a snapshot naming those files.
- **UN1.** If a hook's `event` does not map to a Codex-supported event, then the adapter shall emit warning `HH-W003` and skip that hook.
- **UN2.** If `.codex/config.toml` already contains a `[hooks]` table, then the adapter shall warn (`HH-W005` — duplicate hook sources) rather than silently double-defining hooks in `.codex/hooks.json`.

## Acceptance criteria

- [ ] Adapter at `src/adapters/codex.ts`.
- [ ] Unit tests cover: instructions/skills no-op reporting; hooks.json emit; stable-command emission; event mapping; unmapped event → `HH-W003`; size-cap warning `HH-W004`; existing `[hooks]` table → `HH-W005`.
- [ ] Fixture-based round-trip test: IR → adapter → emitted files → re-parse → IR equivalence (hooks only).
- [ ] Projection summary distinguishes `native` (no file emitted by design) from `emitted` and `skipped`.

## Out of scope
- Writing files to disk (the adapter only returns `EmittedFile[]`; C2 writes them).
- `AGENTS.override.md` / `project_doc_fallback_filenames` handling (detect-and-warn only in v1).
