# F1 — Canonical IR types and parser

**Type:** Foundational
**Depends on:** F0
**Blocks:** F3, A1, A2, A3, A4, C1, C2, C3
**Labels:** `enhancement`, `foundation`

## Context
The PRD's pipeline (§12) routes everything through an in-memory IR (`Instruction[]`, `Skill[]`, `Hook[]`). Every adapter consumes this IR; every command produces or compares against it. This story defines the IR types and the parser that lifts canonical files (`AGENTS.md`, `.agents/skills/<name>/SKILL.md`, `.agents/hooks/<event>.<name>.*`) into the IR.

## Requirements (EARS)

- **U1.** The package shall expose TypeScript types `Instruction`, `Skill`, `Hook`, and `IR` as defined in [PRD §8](../PRD.md).
- **U2.** A parser function shall read a repo directory and return an `IR` containing every canonical artifact it found.
- **EV1.** When the parser encounters an `AGENTS.md`, it shall produce one `Instruction` whose `scope` is the file's directory (or the `scope` glob from frontmatter, if present).
- **EV2.** When the parser encounters a `.agents/skills/<name>/SKILL.md`, it shall produce one `Skill` whose `name` and `description` come from frontmatter and whose `body` is the post-frontmatter markdown.
- **EV3.** When the parser encounters a `.agents/hooks/<event>.<name>.<ext>` file, it shall produce one `Hook` with that event, name, and the file's body as `script`.
- **EV4.** When the parser encounters an unrecognized file under `.agents/`, it shall include it in the IR as an opaque `attachment` and emit a `WARN HH-W010 unknown attachment`.
- **UN1.** If frontmatter is malformed YAML, then the parser shall fail with exit code 3 and a file-pointed error message.
- **UN2.** If two skills share a `name`, then the parser shall fail with exit code 3 naming both paths.

## Acceptance criteria

- [ ] Types exported from `src/ir.ts`.
- [ ] Parser exported from `src/parse.ts` with signature `parseRepo(cwd: string): Promise<IR>`.
- [ ] Unit tests cover: root `AGENTS.md`, nested `AGENTS.md`, scoped frontmatter, skill folder, hook file, malformed frontmatter, duplicate skill name, unknown attachment.
- [ ] Parser walk respects `.gitignore` (uses `ignore` package or equivalent).
- [ ] `audit` and `apply` (when implemented) call this parser as their first step.

## Out of scope
- Validating that hook events are members of a fixed enum — defer to F3 / adapters which know their target's event taxonomy.
- Projecting IR back to disk (covered by F3, A1–A4).
