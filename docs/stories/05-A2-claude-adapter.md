# A2 — Claude Code adapter

**Type:** Adapter
**Depends on:** F1, F3
**Blocks:** C1, C2, C3
**Labels:** `enhancement`, `adapter`

## Context
Claude Code does not read `AGENTS.md` ([anthropics/claude-code#6235](https://github.com/anthropics/claude-code/issues/6235) still open; docs verbatim: "Claude Code reads CLAUDE.md, not AGENTS.md"). The officially blessed bridge — per the verified [provider matrix](../research/provider-matrix.md) — is a `CLAUDE.md` whose first line is the import `@AGENTS.md`. Scoped instructions project to `.claude/rules/*.md` with `paths:` glob frontmatter (lazily loaded; brace expansion supported). Claude is the **only** provider that does not read `.agents/skills/`, so skills project to `.claude/skills/`. Hooks go inside `.claude/settings.json` under the `hooks` key (~30-event taxonomy), with all other keys preserved.

## Requirements (EARS)

- **U1.** The adapter shall register with `id: 'claude'`.
- **EV1.** When the IR contains a root `Instruction`, the adapter shall emit a `CLAUDE.md` whose first line is `@AGENTS.md` — a one-line import shim, not a content copy. Existing user content below the import line shall be preserved on re-emit (the shim line is the only owned region).
- **EV2.** When the IR contains scoped `Instruction` fragments (`.agents/instructions/*.md` with `scope:`), the adapter shall emit `.claude/rules/hh.<name>.md` files with `paths: [<glob>]` frontmatter.
- **EV3.** When the IR contains nested `Instruction` entries (nested `AGENTS.md`), the adapter shall emit one nested one-line `CLAUDE.md` shim (`@AGENTS.md`, resolving to the sibling file) in each directory containing a nested `AGENTS.md` — Claude loads subdirectory CLAUDE.md files on demand when reading files there, and without the shim the nested AGENTS.md content would be invisible to Claude.
- **EV4.** When the IR contains `Skill` entries, the adapter shall emit them as `.claude/skills/<name>/SKILL.md` (copying sibling files), restricted to the Agent Skills common-core frontmatter (`name`, `description`).
- **EV5.** When the IR contains `Hook` entries, the adapter shall write the `hooks` key inside `.claude/settings.json` (mode `merge-key`), mapping canonical events to Claude's PascalCase taxonomy and leaving all other top-level keys untouched.
- **OPT1.** Where a canonical `scope` glob cannot be expressed in Claude's `paths:` glob dialect, the adapter shall emit warning `HH-W001` with the downgraded glob.
- **UN1.** If the existing `.claude/settings.json` is malformed JSON, then the adapter shall fail and report the error (do not silently overwrite).
- **UN2.** If an existing `CLAUDE.md` does not begin with the `@AGENTS.md` import and contains substantive content, then the adapter shall treat it as a contradiction source for `init` (C3) rather than overwriting.

## Acceptance criteria

- [ ] Adapter at `src/adapters/claude.ts`.
- [ ] Tests cover: one-line shim emit + user-content preservation below the import; nested shim per nested AGENTS.md; `.claude/rules/` emission with `paths:` frontmatter; skills emit (common core only); settings.json merge preserves user keys; event-name mapping; malformed settings.json refusal; non-shim CLAUDE.md detection.
- [ ] Fixture-based round-trip test for skills and rules.

## Out of scope
- Switching to native `AGENTS.md` if #6235 ships — future story (adapter's instruction surface becomes a no-op).
- Claude-specific skill frontmatter extras (`context: fork`, skill-scoped `hooks`, …) — pass-through + lossy warning handled by F3's common policy.
