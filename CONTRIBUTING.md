# Contributing to harness-haircut

Thanks for considering a contribution. This page is the on-ramp; the substance lives in [`AGENTS.md`](AGENTS.md).

## Before you start

1. Read [`AGENTS.md`](AGENTS.md) — tech stack, architecture, definition of done. It is the canonical standards document; everything else (including `CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md`) is a projection of it.
2. Skim [`docs/PRD.md`](docs/PRD.md) for product context.
3. Pick a story from [`docs/stories/`](docs/stories/) — each maps to a GitHub issue, and the dependency chain is documented in [`docs/stories/README.md`](docs/stories/README.md). Comment on the issue to claim it.

## Development loop

Requires Node.js 24+ (`nvm use` picks it up from [`.nvmrc`](.nvmrc)).

```sh
npm ci
npm run build      # tsc -p tsconfig.build.json + shebang fixup
npm run lint       # ESLint (type-aware)
npm run typecheck  # tsc --noEmit across src/, test/, scripts/
npm test           # build + node --test
```

## Standards that will be enforced in review

- **Architecture:** CLEAN layers with inward-pointing dependencies — [`.agents/instructions/software-architecture.md`](.agents/instructions/software-architecture.md).
- **Tests:** every EARS rule in the story you implement gets a test — [`.agents/instructions/testing.md`](.agents/instructions/testing.md).
- **Commits:** Conventional Commits — [`.agents/instructions/commit-style.md`](.agents/instructions/commit-style.md).
- **PRs:** description includes Summary, Spec alignment (mapping to EARS rules / PRD sections), and Test plan. CI must be green before review.

## Editing project standards

Standards changes land in `AGENTS.md` or `.agents/instructions/<topic>.md` **first**, then are re-projected by hand into the per-provider files (until `harness-haircut apply` ships and does it automatically — tracked in [#12](https://github.com/mknoth197/harness-haircut/issues/12)).

## Questions

Open an issue. If standards are ambiguous, prefer the simpler interpretation and open an issue to codify the answer.
