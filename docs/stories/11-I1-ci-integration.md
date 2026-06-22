# I1 — CI integration: pre-commit installer + GitHub Action template

**Type:** Integration
**Depends on:** C1, C2
**Blocks:** I2 (release polish)
**Labels:** `enhancement`, `integration`

## Context
[PRD §13](../PRD.md) ships two CI artifacts: a pre-commit installer that runs `audit` on each commit, and a documented GitHub Action template users paste into their workflows.

## Requirements (EARS)

- **U1.** The package shall expose a sub-command `harness-haircut install-precommit` that installs a hook calling `npx harness-haircut audit --json`.
- **U2.** The package shall ship `templates/github-action.yml` documented in the README. (#43) The template shall run `audit --fail-on drift` so its CI policy matches the pre-commit hook — failing on drift (1) / invalid config (3) but tolerating a standing lossy warning (exit 2), which would otherwise turn a drift-free repo's CI permanently red.
- **EV1.** When `install-precommit` is invoked in a repo using `husky`, the command shall write to `.husky/pre-commit`.
- **EV2.** When `install-precommit` is invoked in a repo without husky, the command shall write directly to `.git/hooks/pre-commit` (chmod +x).
- **OPT1.** Where `--force` is set, the command shall overwrite an existing pre-commit hook; otherwise it shall append to it with a clear marker.
- **UN1.** If `.git` is not present, then the command shall fail with exit 3.

## Acceptance criteria

- [ ] Sub-command at `src/commands/install-precommit.ts`.
- [ ] `templates/github-action.yml` is valid YAML, runs `audit --fail-on drift`, fails on drift/config exit (1/3) but not on a standing lossy warning (2).
- [ ] Tests cover: husky path, plain `.git/hooks` path, append-with-marker path, `--force` overwrite, no-`.git` failure.
- [ ] README documents both CI integration paths.

## Out of scope
- A GitHub Marketplace listing.
- Pre-push or post-commit hooks (out of v1).
