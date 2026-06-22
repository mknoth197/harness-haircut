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

## Data-loss hardening (PR #25 review — no silent loss, PRD goal 3)

Two consolidation-time data-loss gaps were closed after the initial implementation:

### F1 — scoped instruction fragments are recovered into canonical

Beyond root instructions and skills, `init` now recovers **per-file scoped instruction fragments** so their unique content is consolidated instead of dropped (and the orphan file later clobbered by `apply`):

- `.github/instructions/*.instructions.md` — `applyTo:` frontmatter (comma-separated globs) becomes the canonical `scope`. The `hh.nested-*` projection is skipped (its canonical home is a nested `AGENTS.md`, not a fragment).
- `.claude/rules/*.md` — `paths:` frontmatter (inline `[...]` array, block sequence, or scalar) becomes the canonical `scope`.
- Each recovered fragment is written to `.agents/instructions/<name>.md` with a `scope:` frontmatter and the recovered body **before** `apply` runs, so `apply` re-projects it and the formerly-orphan provider file gains canonical backing (closing the `unmanaged → overwrite` clobber path in `apply`). `<name>` is the source filename with any `hh.` prefix and the `.instructions`/`.md` suffix stripped.
- A harness-emitted `SignedSource` header after the frontmatter is stripped on recovery; a hand-written drifted fragment with no header keeps its whole post-frontmatter body.
- **Contradictions:** same canonical fragment name recovered from multiple providers with byte-identical (normalized) scope+body collapses to one (EV1); differing copies surface a `fragment:<name>` contradiction resolved like the others. Fragment names are their own namespace under `.agents/instructions/` — a fragment named `foo` never collides with a root or skill slot.
- A fragment under a fragment root with **no** `applyTo:`/`paths:` frontmatter cannot yield a scope; rather than drop it, `init` surfaces it in `InitReport.notes` (mirroring the hooks note) and leaves the file in place.
- Note: a scoped fragment with **Gemini enabled** still produces `HH-W007` at audit (Gemini has no path-scoping), so `audit` after recovery is exit 2 unless Gemini is disabled — this is inherent to scoped fragments, not a recovery defect.

### F2 — non-chosen contradiction candidates are preserved and reported

When a contradiction is resolved by choosing one candidate (or skipping), the other candidates' unique content would be destroyed by the subsequent `apply`. `init` now:

- **Backs up** every non-chosen candidate's original text to `<repo-root>/.harness-haircut-init-backup/<sanitized-source-path>` (e.g. `.github__copilot-instructions.md`) before calling `apply`. The backup directory sits **outside** `.agents/` at the repo root deliberately: the parser walk (`readRepoSnapshot` → `parseRepo`) only collects `AGENTS.md` at any depth plus everything under root `.agents/`, so the backup is never read back into IR or re-projected. (Under `.agents/` it would be walked — the `.harness-state.json` skip lives in `parse-repo.ts`, out of scope for this fix.) Backups are skipped under `--dry-run`.
- **Reports** the backups: `InitReport.backups: string[]` carries the backup paths (surfaced by `--json`), `renderInitReport` lists which source paths were preserved and the backup directory, and per-contradiction notes name them.
- The interactive resolver preview was widened from 60 chars to the first ~12 lines (≤~400 chars, with a truncation marker) so the choice between candidates is informed.

### #45 — skipped symlinked provider files are noted (no silent omission)

The snapshot walk never follows symlinks (a link can escape the repo or cycle — the pen-test stance), so a symlinked provider file/dir (e.g. a `.claude/skills/<name>` that links into `.agents/skills/`) is invisible to import. Rather than drop it silently, the gateway records each such path in `RepoSnapshot.skippedSymlinks`, and `init` surfaces them in `InitReport.notes` (mirroring the hooks/unparseable-fragment notes): *"skipped N symlinked path(s) — symlinks are not followed, so their content was NOT imported (…). Replace a symlink with the real file/directory…"*. The skip itself remains correct policy; only the silence is fixed. A symlink the user gitignored or `exclude`d is skipped quietly (the exclusion is intentional).

### #47 — init surfaces the chained apply's warnings; piped prompts echo cleanly

- `init` chains `apply`; that projection can raise standing lossy warnings (HH-W001/W007). `init` used to print only `projected N provider file(s) via apply (exit 0)` and drop the warnings, so a user first met them at the *next* `audit` (exit 2), which reads like a surprise regression. `renderInitReport` now prints the chained apply's warning block under the projection line, labelled *standing — not new drift*.
- The shared `createStdinPrompt` (layer 4, used by `init`/`apply`) echoes a consumed answer + newline when stdin is **piped** (readline does not echo a non-TTY), so transcripts/CI logs no longer run the next output onto the prompt line (`Choice [1-3]: detected …`). A real TTY already echoes keystrokes, so the manual echo is suppressed there.

## Out of scope
- Migration commands from specific tools (`migrate-from cursor`) — listed in PRD §15 future scope.
