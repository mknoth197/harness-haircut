# C2 — `apply` command

**Type:** Command
**Depends on:** F1, F2, F3, all adapters (A1–A4)
**Blocks:** C3, I1
**Labels:** `enhancement`, `command`

## Context
`apply` is the write half of the system. Per [PRD §7](../PRD.md), it refuses to run with a dirty git tree by default, prompts on user-edited generated files, and is idempotent.

## Requirements (EARS)

- **U1.** The command shall write only the files returned by adapters; it shall not delete files outside the adapters' declared output paths.
- **EV1.** When the canonical IR matches every emitted-file projection on disk, the command shall print `nothing to do` and exit 0.
- **EV2.** When an emitted file's body differs from disk, the command shall overwrite it (subject to UN-rules below) and add it to the change report.
- **EV3.** When any adapter emits a `merge-key` file, the command shall read the existing file, replace only the owned key(s), and write the merged result.
- **STATE1.** While the working tree contains uncommitted changes (per `git status --porcelain`), the command shall refuse to run unless `--allow-dirty` was passed.
- **OPT1.** Where `--dry-run` is set, the command shall print the would-emit diff and exit without writing.
- **UN1.** If a target file's SignedSource header indicates user edits (`verifyHeader → 'edited'`), then the command shall prompt for overwrite, or fail with exit 1 when `--non-interactive` is set.
- **UN2.** If a `merge-key` target file is malformed (invalid JSON/TOML), then the command shall fail with exit 3, naming the file.
- **UN3.** If two adapters target the same path with `mode: overwrite`, then the command shall fail before any write.
- **UN4.** (#40) If a target file verifies as `unmanaged` (an owned path holds a hand-written file with **no** SignedSource header), then the command shall **back up the original verbatim** under `.harness-haircut-apply-backup/` and **prompt** for overwrite, or **fail with exit 1** when `--non-interactive` is set — honoring [PRD §9](../PRD.md) "never overwrite an unmanaged file silently". `init`'s chained `apply` is the sole exception: it has already reconciled the pre-existing foreign files interactively (C3), so it claims those paths without a prompt or backup (`claimUnmanaged`).

## Acceptance criteria

- [ ] Command at `src/commands/apply.ts`.
- [ ] Idempotency test: `apply && audit` exits 0.
- [ ] Tests cover: clean run, user-edited file prompt path, `--non-interactive` failure path, `--allow-dirty`, `--dry-run`, merge-key into existing JSON preserves foreign keys, conflict between adapters fails fast.
- [ ] Tests cover the `unmanaged` takeover (UN4): interactive confirm → original backed up + path overwritten; interactive decline → blocked, original untouched; `--non-interactive` → exit 1, original untouched; `claimUnmanaged` (init's chained apply) → overwrites with no prompt/backup; the backup dir is not re-collected as canonical.
- [ ] Git status check uses `git status --porcelain` shelled out (not a libgit dependency).

## Design note — headerless fully-owned JSON files (PRD §9 carve-out 2)

`.codex/hooks.json` and `.github/hooks/*.json` carry no SignedSource header (JSON has no comments), so verification for them is full-content comparison against the current projection — which cannot distinguish `edited` (user touched the file) from `stale` (canonical sources changed). To restore the distinction for the UN1 prompt flow, `apply` should record the prior emission (e.g. content hash in a tool-state file) and compare three ways: disk == current projection → clean; disk == recorded prior emission → stale (safe overwrite); otherwise → edited (prompt). Until that lands, treat any difference as `edited` (the conservative side).

## Out of scope
- Initial onboarding / interactive merge from drifted state (covered by C3).
