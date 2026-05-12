<!-- @hand-emitted-projection
This file is a hand-emitted projection of AGENTS.md + .agents/instructions/*.
When `harness-haircut apply` ships (C2 #12), this file will be regenerated
automatically and the hand-emit step goes away. Until then, edits should
land in AGENTS.md or the relevant .agents/instructions/<topic>.md file
first, then be re-projected here by hand.

Tracking: https://github.com/mknoth197/harness-haircut/issues/17
-->

# Project standards (Gemini CLI projection)

The canonical project standards live in [`AGENTS.md`](AGENTS.md). This file is a projection for Gemini CLI. Treat this file as a pointer:

**Read first:**
- [`AGENTS.md`](AGENTS.md) — project overview, tech stack, architecture, definition of done.

**Per-topic standards** (apply when working in the listed scope):

| Topic | Scope | File |
|---|---|---|
| Software architecture (CLEAN layers) | `src/**/*.ts` | [`.agents/instructions/software-architecture.md`](.agents/instructions/software-architecture.md) |
| Testing | `test/**/*.ts` | [`.agents/instructions/testing.md`](.agents/instructions/testing.md) |
| Commit style | repo-wide | [`.agents/instructions/commit-style.md`](.agents/instructions/commit-style.md) |

**Product context:**
- [`docs/PRD.md`](docs/PRD.md) — what we're building and why.
- [`docs/stories/`](docs/stories/) — EARS user stories, one per planned GitHub issue.

**When in doubt:** check `AGENTS.md` first, then the relevant `.agents/instructions/<topic>.md`. If both are silent, prefer the simpler option and open an issue.
