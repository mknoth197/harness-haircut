# C3 — `init` command (interactive onboarding)

**Type:** Command
**Depends on:** F1, F3, all adapters, C2
**Blocks:** I2 (release blocked on full-loop UX)
**Labels:** `enhancement`, `command`

## Context
[PRD §4 use case 1](../PRD.md) — the primary onboarding flow. `init` runs `detectExisting` on every adapter, surfaces contradictions between drifted files, prompts the user to pick the canonical answer per contradiction, writes canonical layout, then calls `apply`.

## Requirements (EARS)

- **U1.** The command shall, in order: detect existing provider files, build a *candidate* canonical IR by union, identify contradictions, resolve contradictions interactively, write canonical files, invoke `apply`.
- **EV1.** When two existing files agree on a logical content slot (same instruction text), the command shall use that text without prompting.
- **EV2.** When two existing files disagree on a slot, the command shall present a 3-way diff (file A, file B, "skip / write blank") and prompt for selection.
- **EV3.** When the user selects an option, the command shall record the choice in the IR and continue to the next contradiction.
- **OPT1.** Where `--non-interactive` is set, the command shall fail on the first contradiction with exit 1, listing all contradictions in the report.
- **OPT2.** Where `--dry-run` is set, the command shall print the planned canonical layout and exit without writing.
- **UN1.** If the repo already contains canonical artifacts (`AGENTS.md` at root that has a SignedSource-style hash or `.agents/` directory), then the command shall fail and recommend `apply` instead.

## Acceptance criteria

- [ ] Command at `src/commands/init.ts`.
- [ ] Tests cover: zero-contradiction repo (auto-merges), single-contradiction repo (prompts and resolves), `--non-interactive` failure, "already canonical" fast-fail, integration test that ends with `audit` exit 0.
- [ ] Prompt UX uses `prompts` or `@inquirer/prompts` (no custom TTY code).

## Out of scope
- Migration commands from specific tools (`migrate-from cursor`) — listed in PRD §15 future scope.
