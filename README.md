# harness-haircut

Audit and consolidate redundant AI-provider configuration files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md`, …) into a single canonical source of truth, then project that source into each provider's native format.

> **Status:** v0.1.0. The four core commands (`init`, `apply`, `audit`, `doctor`) and the `install-precommit` helper are implemented across four provider adapters (Codex, Claude, Gemini, Copilot). See [`CHANGELOG.md`](CHANGELOG.md) for the release notes, [`docs/PRD.md`](docs/PRD.md) for the product requirements, and [`docs/stories/`](docs/stories/) for the EARS user stories.
>
> **Contributing?** Read [`AGENTS.md`](AGENTS.md) first — it's the canonical entry-point for project standards (tech stack, CLEAN architecture, testing, commit style).

## Quick start

Requires Node.js 24 or later. No install step — run it through `npx`:

```sh
npx harness-haircut init      # bootstrap the canonical AGENTS.md + .agents/ layout
npx harness-haircut apply     # project canonical sources into each provider's files
npx harness-haircut audit     # read-only drift check (CI-friendly; exits non-zero on drift)
```

`init` scans the repo, resolves any contradictions between existing provider
configs interactively, writes the canonical layout, and runs `apply`. From
then on, edit `AGENTS.md` / `.agents/` and re-run `apply`; `audit` is the
read-only check you wire into CI and pre-commit. `apply && audit` is
idempotent — it exits 0 on a clean tree.

Other commands:

```sh
npx harness-haircut doctor              # print version, Node, detected providers, config
npx harness-haircut install-precommit   # install a pre-commit hook that runs `audit`
```

### Pre-commit hook

`install-precommit` writes a hook that runs `harness-haircut audit --json` and
blocks the commit on **drift** (exit 1) or a **config error** (exit 3). An
informational lossy-translation warning (exit 2) does **not** block — a standing
`HH-Wxxx` is a persistent property of a canonical config, so blocking on it
would wedge every commit on a drift-free repo.

```sh
npx harness-haircut install-precommit          # append a fenced harness block
npx harness-haircut install-precommit --force  # overwrite an existing hook wholesale
```

It targets `.husky/pre-commit` when [husky](https://typicode.github.io/husky/)
is present, otherwise the repo's real git hooks directory (resolved via
`git rev-parse --git-path hooks`, so worktrees and submodules work too), and
makes the hook executable. Re-running is idempotent — the harness block is
fenced with markers and never duplicated. Run it from inside a git repository
(it exits 3 otherwise).

### Continuous integration

To fail a PR check on drift, copy [`templates/github-action.yml`](templates/github-action.yml)
into your repo's `.github/workflows/`. It checks out the repo, sets up Node 24,
runs `npm ci`, then `npx harness-haircut audit` — a non-zero exit (drift, a
lossy-translation warning, or invalid config) fails the check.

## Local development

Requires Node.js 24 or later.

```sh
npm install
npm run build      # tsc + shebang fixup
npm test           # node --test against the built CLI
npm run lint       # ESLint
npm run typecheck  # tsc --noEmit
```

The compiled binary lives at `dist/bin.js`. You can run it directly during development:

```sh
node dist/bin.js --version
node dist/bin.js --help
node dist/bin.js audit --cwd /path/to/repo
```

## Project layout

```
AGENTS.md        Canonical project standards (read first)
CLAUDE.md        One-line @AGENTS.md import shim for Claude Code (cannot drift; `apply` will own it once C2 ships)
GEMINI.md        One-line @AGENTS.md import shim for Gemini CLI (same)
.agents/
  instructions/  Canonical per-topic standards (CLEAN, testing, commits)
.github/
  copilot-instructions.md  Full Copilot projection (code review reads neither AGENTS.md nor imports)
  instructions/  Path-scoped Copilot instructions (`applyTo`-flavored projections of .agents/instructions/)
  workflows/     CI
src/             TypeScript sources
  bin.ts         Executable entry — calls run() and exits with its code
  cli.ts         Pure module: parseArgs(), run(), types
  index.ts       Library exports
test/            Tests (TypeScript, run via `node --test` with native type-stripping on Node 24)
scripts/         Build + repo helper scripts (TypeScript)
docs/
  PRD.md         Product requirements (v0.3 — see audit log at top)
  research/      Verified provider-config matrix (citations; normative for adapters)
  stories/       EARS user stories, one per planned issue
```

## Contributing

Start with [`AGENTS.md`](AGENTS.md) for the standards, then pick a story from [`docs/stories/`](docs/stories/) — they're ordered and the dependency chain is documented in [`docs/stories/README.md`](docs/stories/README.md). The foundational (F-series), adapter (A-series), command (C-series), and integration (I-series) stories that make up v0.1.0 are implemented; remaining work is tracked as GitHub issues.

## License

MIT — see [`LICENSE`](LICENSE).
