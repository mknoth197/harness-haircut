<!-- @hand-emitted-projection
This file is a hand-emitted projection of AGENTS.md + .agents/instructions/*.
When `harness-haircut apply` ships (C2 #12), this file will be regenerated
automatically and the hand-emit step goes away. Until then, edits should
land in AGENTS.md or the relevant .agents/instructions/<topic>.md file
first, then be re-projected here by hand.

Tracking: https://github.com/mknoth197/harness-haircut/issues/17
-->

# Project standards (GitHub Copilot projection)

The canonical project standards live in [`AGENTS.md`](../AGENTS.md). This file is a projection for GitHub Copilot, which reads `.github/copilot-instructions.md` at the repo root and `.github/instructions/*.instructions.md` for path-scoped rules (`applyTo` frontmatter).

**Read first:**
- [`AGENTS.md`](../AGENTS.md) — project overview, tech stack, architecture, definition of done.

**Path-scoped instructions** (Copilot picks these up automatically via `applyTo`):

- [`.github/instructions/software-architecture.instructions.md`](instructions/software-architecture.instructions.md) — `applyTo: "src/**/*.ts"`
- [`.github/instructions/testing.instructions.md`](instructions/testing.instructions.md) — `applyTo: "test/**/*.ts"`
- [`.github/instructions/commit-style.instructions.md`](instructions/commit-style.instructions.md) — `applyTo: "**/*"`

**Product context:**
- [`docs/PRD.md`](../docs/PRD.md) — what we're building and why.
- [`docs/stories/`](../docs/stories/) — EARS user stories, one per planned GitHub issue.

**When in doubt:** check `AGENTS.md` first, then the relevant `.github/instructions/<topic>.instructions.md` for path-scoped rules. If both are silent, prefer the simpler option and open an issue.
