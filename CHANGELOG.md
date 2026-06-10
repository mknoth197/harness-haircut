# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).
While the version is `0.x`, public types and `run()` behavior may change between
minor versions (see [`AGENTS.md`](AGENTS.md) "Definition of Done").

## [Unreleased]

### Fixed

- **Release workflow** now routes tags fail-closed: an exact `vX.Y.Z` publishes
  to `latest`, a `vX.Y.Z-<suffix>` pre-release publishes to `next`, and any
  malformed tag (`vX.Y.Z.W`, `vX.Y.Z-rc1`, …) refuses to publish. Previously a
  non-`rc.N` pre-release tag could reach the `latest` dist-tag.
- **Pre-commit hook** no longer blocks a commit on an informational
  lossy-translation warning (audit exit 2); it blocks only on drift (exit 1) or
  a config error (exit 3). A standing `HH-Wxxx` on a drift-free repo no longer
  wedges every commit.
- **`install-precommit`** resolves the real git hooks directory via
  `git rev-parse --git-path hooks`, so a worktree or submodule (where `.git` is
  a file) installs correctly instead of crashing with exit 70. When `git` is
  unavailable, it now fails with a clear exit-3 domain error.
- **`doctor --config <path>`** now warns when the explicitly specified config
  file does not exist, instead of silently falling back to defaults.

## [0.1.0] - 2026-06-10

First public release. `harness-haircut` audits a single repository and
consolidates redundant AI-provider configuration files into one canonical
source of truth (`AGENTS.md` + `.agents/`), then projects that source into
each provider's native format.

### Added

- **Commands**
  - `init` — bootstrap the canonical layout from an existing repo, surfacing
    and interactively resolving contradictions between provider configs, then
    calling `apply`.
  - `audit` — read-only drift check. Exit codes per PRD §7: `0` clean,
    `1` drift, `2` lossy-translation warning, `3` invalid config. `--json`
    emits a structured report; `--strict` escalates warnings to a failure.
  - `apply` — project canonical sources into provider files. Refuses on a
    dirty git tree without `--allow-dirty`; prompts before overwriting a
    user-edited file (or fails under `--non-interactive`); idempotent
    (`apply && audit` exits 0 on a clean tree). `--dry-run` previews.
  - `doctor` — print version, Node version, cwd, detected providers, the
    parsed config, and any environment warnings. Exit `3` on an invalid config.
  - `install-precommit` — install a git pre-commit hook that runs
    `npx harness-haircut audit --json`. The hook blocks the commit on drift
    (exit 1) or a config error (exit 3); an informational lossy-translation
    warning (exit 2) does not block. Detects husky (`.husky/pre-commit`) or
    falls back to the repo's real git hooks directory resolved via
    `git rev-parse --git-path hooks` (so worktrees and submodules work),
    chmod +x. `--force` overwrites; otherwise appends an idempotent, fenced
    harness block.
- **Provider adapters** (four, in A-story order): Codex, Claude, Gemini, and
  Copilot — each projecting the instructions, skills, and hooks surfaces into
  the provider's native files and merge-key settings.
- **SignedSource header** — a `@generated SignedSource` header embeds a body
  hash and a sources hash so `audit`/`apply` can tell a clean file from a
  user-edited or stale one without a separate manifest.
- **Lossy-translation warnings catalogue** (`HH-Wxxx`) — every translation
  that cannot be represented faithfully in a provider's format emits an
  actionable warning instead of silently dropping content.
- **CI integration** — `templates/github-action.yml`, a paste-in GitHub Action
  that runs `audit` and fails the check on drift.
- **Packaging** — published via npm for `npx harness-haircut`; the package
  ships only `dist/`, `templates/`, `README.md`, `LICENSE`, and `package.json`.
  A tagged release workflow publishes with npm provenance.

### Known limitations

- A canonical source inside a fully `.gitignore`-d directory is not collected
  and does not warn (HH-W012 scope; see [`docs/warnings/HH-W012.md`](docs/warnings/HH-W012.md)).
- `uvx` / Python distribution is post-v1 (PRD §15).

[Unreleased]: https://github.com/mknoth197/harness-haircut/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/mknoth197/harness-haircut/releases/tag/v0.1.0
