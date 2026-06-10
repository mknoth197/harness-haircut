# A4 — GitHub Copilot adapter

**Type:** Adapter
**Depends on:** F1, F3
**Blocks:** C1, C2, C3
**Labels:** `enhancement`, `adapter`

## Context
Per the verified [provider matrix](../research/provider-matrix.md), Copilot's instruction surface is split by product surface: the coding/cloud agent, CLI, and VS Code read **`AGENTS.md` natively (root + nested, since 2025-08-28)** — but **Copilot code review does not**, so `.github/copilot-instructions.md` and path-scoped `.github/instructions/*.instructions.md` (`applyTo` globs; no negation/braces) must still be emitted to cover review. Skills are a **no-op** (Copilot reads `.agents/skills/` natively since 2025-12-18). Hooks go to `.github/hooks/*.json` (`version: 1` schema; cloud agent reads them from the default branch only; also CLI + VS Code preview).

## Requirements (EARS)

- **U1.** The adapter shall register with `id: 'copilot'`.
- **EV1.** When the IR contains a root `Instruction`, the adapter shall emit `.github/copilot-instructions.md` — needed for the code-review surface even though other surfaces read AGENTS.md natively. The file shall note (in an HTML comment) that it exists for code review and that AGENTS.md is authoritative.
- **EV2.** When the IR contains a scoped `Instruction` fragment, the adapter shall emit `.github/instructions/hh.<name>.instructions.md` with `applyTo:` frontmatter set to the scope glob (comma-separated for multiple globs).
- **EV2b.** When the IR contains a nested `AGENTS.md` instruction, the adapter shall emit `.github/instructions/hh.nested-<dirpath>.instructions.md` with `applyTo: "<dir>/**"` so the **code-review surface** (which reads neither root nor nested AGENTS.md) still receives the content — otherwise nested instructions would be silently lost on review, violating Goal 3 / §16 "zero silent data loss". Other Copilot surfaces read nested AGENTS.md natively and ignore the duplication cleanly per the precedence rules.
- **EV3.** When the IR contains `Skill` entries, the adapter shall emit nothing and report the surface as `native` (Agent Skills standard; `.agents/skills/` is searched).
- **EV4.** When the IR contains `Hook` entries with mappable events, the adapter shall emit `.github/hooks/harness-haircut.json` with `{"version": 1, "hooks": {...}}` using camelCase event names and the conservative cross-surface entry schema `{type: "command", bash: ..., powershell: ...}` (the newer bare-`command`/`http`/`prompt` forms are not emitted in v1).
- **OPT1.** Where a `scope` glob uses syntax outside Copilot's documented `applyTo` capabilities (negation, brace expansion), the adapter shall emit warning `HH-W001` and downgrade to the closest expressible glob.
- **OPT2.** Where a canonical hook event has no Copilot equivalent, the adapter shall emit warning `HH-W003` and skip it. The mapping table includes `pre-tool-use` → `preToolUse` (note: **fail-closed** on the cloud agent — document this in the emitted file comment), `user-prompt-submit` → `userPromptSubmitted`, `stop` → `agentStop`, `session-start`/`session-end` → `sessionStart`/`sessionEnd`.
- **UN1.** If two scoped fragments would flatten to the same `.instructions.md` filename, then the adapter shall fail before emit, naming both source paths.
- **UN2.** If hooks are emitted on a non-default branch context, the adapter shall include an informational note that the cloud agent only honors hooks from the default branch (no warning code — informational).

## Acceptance criteria

- [ ] Adapter at `src/adapters/copilot.ts`.
- [ ] Tests cover: root emit with code-review rationale comment; scoped → `applyTo` flat files; nested AGENTS.md → `hh.nested-*` flat files with subtree `applyTo`; collision detection; skills native no-op; hooks JSON with `version: 1` + camelCase events + bash/powershell pairs; lossy glob warning; unmappable event warning.
- [ ] Lossy-translation test asserts both the warning code *and* the downgraded glob shape.

## Out of scope
- `excludeAgent` frontmatter emission (v1 emits files for all surfaces; per-surface exclusion is a v2 refinement).
- Custom agents (`.github/agents/*.agent.md`), prompt files (`.github/prompts/`), `copilot-setup-steps.yml` — not part of the three v1 layers.
- Org/enterprise-level instruction layers (single-repo scope).
