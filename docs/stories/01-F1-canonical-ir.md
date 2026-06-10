# F1 — Canonical IR types and parser

**Type:** Foundational
**Depends on:** F0
**Blocks:** F3, A1, A2, A3, A4, C1, C2, C3
**Labels:** `enhancement`, `foundation`

## Context
The PRD's pipeline (§12) routes everything through an in-memory IR (`Instruction[]`, `Skill[]`, `Hook[]`). Every adapter consumes this IR; every command produces or compares against it. This story defines the IR types and the parser that lifts canonical files (`AGENTS.md`, `.agents/instructions/<name>.md`, `.agents/skills/<name>/SKILL.md`, `.agents/hooks/<event>.<name>.*`) into the IR. Format rules follow [PRD §8 v0.3](../PRD.md) as verified in the [provider matrix](../research/provider-matrix.md): AGENTS.md is pure markdown (no frontmatter), scoped fragments carry `scope:` frontmatter, hook events come from the canonical nine-event enum.

## Requirements (EARS)

- **U1.** The package shall expose TypeScript types `Instruction`, `Skill`, `Hook`, `HookEvent`, and `IR` as defined in [PRD §8](../PRD.md), in the entities layer (`src/entities/`).
- **U2.** A parser function shall read a repo directory and return an `IR` containing every canonical artifact it found.
- **U3.** The canonical `HookEvent` enum shall be exactly: `session-start`, `session-end`, `user-prompt-submit`, `pre-tool-use`, `post-tool-use`, `stop`, `subagent-start`, `subagent-stop`, `pre-compact` (PRD §8 v0.3; `pre-commit` is deliberately absent — no provider has it).
- **EV1.** When the parser encounters a root or nested `AGENTS.md`, it shall produce one `Instruction` whose scope is the file's directory subtree. AGENTS.md is parsed as pure markdown — frontmatter is **not** interpreted.
- **EV2.** When the parser encounters `.agents/instructions/<name>.md`, it shall produce one scoped `Instruction` whose `scope` glob comes from the required `scope:` frontmatter key.
- **EV3.** When the parser encounters a `.agents/skills/<name>/SKILL.md`, it shall produce one `Skill` whose `name` and `description` come from frontmatter and whose `body` is the post-frontmatter markdown; sibling files are recorded as attachments of the skill.
- **EV4.** When the parser encounters a **hook-shaped** file in `.agents/hooks/` — basename has ≥3 dot-segments, final extension is `sh` or `js`, and no segment is empty — it shall produce one `Hook` with that event, name (the middle segments, which may themselves contain dots: `pre-tool-use.my.fancy.sh` → name `my.fancy`), and the file's body as `script`.
- **EV5.** When the parser encounters an unrecognized file under `.agents/`, it shall include it in the IR as an opaque `attachment` and emit a `WARN HH-W010 unknown attachment`. This includes every non-hook-shaped file in `.agents/hooks/` — dotfiles (`.DS_Store`), READMEs, `.gitkeep`, `*.bak`, trailing-dot names, **and `.toml`/`.json` files**: the latter are reserved for the future sibling-metadata convention (PRD §8), which is not yet designed, so they are preserved as attachments rather than given invented collision semantics.
- **UN1.** If a root or nested `AGENTS.md` begins with a YAML frontmatter block, then the parser shall emit warning `HH-W011` (frontmatter in AGENTS.md leaks verbatim into provider prompts) and treat the block as literal content.
- **UN2.** If frontmatter in a `.agents/` file is malformed YAML, then the parser shall fail with exit code 3 and a file-pointed error message.
- **UN3.** If two skills share a `name`, then the parser shall fail with exit code 3 naming both paths.
- **UN4.** If a **hook-shaped** file's `<event>` segment is not in the canonical `HookEvent` enum, then the parser shall fail with exit code 3 naming the file and listing valid events. (UN4 applies to hook-shaped files only — per EV4's rule: ≥3 dot-segments, `sh`/`js` extension, no empty segment; everything else in `.agents/hooks/` falls to EV5.)
- **UN5.** If a `.agents/instructions/*.md` file lacks the `scope:` frontmatter key, then the parser shall fail with exit code 3 (scope is what distinguishes a fragment from prose).

## Acceptance criteria

- [ ] Types exported from `src/entities/` (per the CLEAN layer rules in `.agents/instructions/software-architecture.md`).
- [ ] Parser at `src/gateways/` + `src/use-cases/` boundary with signature `parseRepo(deps): Promise<{ ir, warnings }>` (filesystem access injected via `deps` per the dependency-injection rule in `.agents/instructions/software-architecture.md`; assembly logic pure).
- [ ] Unit tests cover: root `AGENTS.md`, nested `AGENTS.md`, AGENTS.md-with-frontmatter warning, scoped instruction fragment, missing-scope failure, skill folder with attachments, hook file, invalid hook event, malformed frontmatter, duplicate skill name, unknown attachment.
- [ ] Parser walk respects `.gitignore`.
- [ ] `audit` and `apply` (when implemented) call this parser as their first step.

## Out of scope
- Per-provider event-name mapping (adapters, A1–A4).
- Projecting IR back to disk (covered by F3, A1–A4).
