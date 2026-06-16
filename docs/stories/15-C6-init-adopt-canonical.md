# C6 — `init --adopt` (adopt a hand-built canonical repo)

**Type:** Command (enhancement to C3)
**Depends on:** C3 (init), C4 (assist — composes), F1, F2
**Revises:** [C3 `UN1`](10-C3-init-command.md) — the already-canonical fast-fail.
**GitHub issue:** [#44](https://github.com/mknoth197/harness-haircut/issues/44)
**Labels:** `enhancement`, `command`

## Context

[PRD §4 use case 1](../PRD.md) — onboarding. C3's `init` refuses the moment a
`.agents/` directory exists (UN1), recommending `apply`. That conflates two very
different repos:

1. **Tool-canonical** — harness-haircut already onboarded this repo. The
   unambiguous marker is the state file `apply` writes
   (`.agents/.harness-state.json`), or a root `AGENTS.md` carrying a SignedSource
   header (only `apply` emits one). For these, `apply` is the right command and
   `init` should keep refusing.
2. **Hand-built canonical** — a repo that adopted the emerging `.agents/skills/`
   /`.agents/instructions/` convention *by hand*, with no harness-haircut state
   file and a hand-written (header-less) `AGENTS.md`. These are arguably the
   tool's **primary** audience — exactly the redundant-config repos it exists to
   consolidate (e.g. a repo with `.agents/skills/`, claude-only `.claude/skills/`,
   a hand-written `AGENTS.md`, and 7 `.github/instructions/*.instructions.md`).

Because UN1 trips on bare `.agents/` existence, the hand-built class **dead-ends**:
`apply` only projects canonical → providers (it never imports claude-only skills
or scoped instruction files into canonical, never runs contradiction resolution),
and — critically — **`--assist` exists only under `init`, so the AI-assisted
merge is unreachable for this whole class of repo.**

C6 adds an explicit **adopt** mode: `init --adopt` treats an existing hand-built
`.agents/**` as the highest-precedence canonical content and runs the normal
onboarding pipeline (contradiction resolution + import of provider-only skills
and scoped instructions) over the remaining provider files.

## Requirements (EARS)

- **AD1.** If the repo is *tool-canonical* — `.agents/.harness-state.json` exists,
  OR root `AGENTS.md` carries a SignedSource header — then the command shall
  refuse (exit 1) and recommend `apply`, **even when `--adopt` is set** (an
  already-managed repo is refreshed by `apply`, not re-adopted).
- **AD2.** If the repo has a `.agents/` directory but is **not** tool-canonical
  (hand-built), and `--adopt` is not set, then the command shall refuse (exit 1)
  and recommend `harness-haircut init --adopt` (NOT `apply`).
- **AD3.** Where `--adopt` is set and the repo is hand-built canonical, the
  command shall run the normal onboarding pipeline (C3 U1), treating existing
  `.agents/**` as the highest-precedence canonical candidates: skills under
  `.agents/skills/`, scoped fragments under `.agents/instructions/`, and root
  text in `AGENTS.md`.
- **AD4.** When a scoped fragment recovered from a provider directory
  (`.github/instructions/`, `.claude/rules/`) shares a canonical name with an
  existing `.agents/instructions/<name>.md`, the command shall treat both as
  candidates for the same `fragment:<name>` slot — collapsing on agreement (EV1)
  or surfacing a contradiction on disagreement (EV2/EV3) — and shall **never**
  silently overwrite the existing canonical fragment (PRD goal 3).
- **AD5.** A fragment source already at its canonical path
  (`.agents/instructions/<name>.md`) shall be overwritten in place and shall
  **never** be displaced to the init backup directory; only provider-directory
  originals are removed, so the projected `hh.*` twin does not double-load
  (consistent with [#37](https://github.com/mknoth197/harness-haircut/issues/37)).
- **AD6.** When a contradiction is resolved away from an existing canonical
  fragment (a provider candidate is chosen, or an AI-merge supersedes it), the
  command shall back up that canonical fragment's verbatim original to the init
  backup directory before overwriting it (F2 — no silent loss). On agreement
  (no contradiction) no backup is written (the rewritten text is equivalent).
- **AD7.** Where `--adopt` composes with `--assist`, `--dry-run`, or
  `--non-interactive`, the flag shall affect **only** the already-canonical
  refusal; resolver selection, preview-and-stop, and interaction semantics are
  unchanged. `init --adopt --assist` is the headline use case (it makes the
  AI-merge reachable for hand-built canonical repos).
- **AD8.** Where `--adopt` is set on a non-canonical repo (no `.agents/`, no
  generated `AGENTS.md`), the command shall behave exactly as plain `init`
  (adopt is a harmless superset).

## Acceptance criteria

- [ ] `InitFlags` gains `adopt: boolean`; `cli.ts` parses `--adopt` and documents
      it under `init options:`.
- [ ] UN1 split into `isToolCanonical` (state file OR signed `AGENTS.md`) and a
      hand-built-shape check; a new `InitReport.refused` value
      (`'hand-canonical-needs-adopt'`) drives the "run `init --adopt`" hint.
- [ ] `.agents/instructions/` added as the highest-precedence fragment source
      root (a `recoverFragmentFromCanonical` parsing `scope:` frontmatter).
- [ ] Tests cover: tool-canonical refusal (state file present → recommend apply,
      even with `--adopt`); hand-built refusal without `--adopt` (recommend
      `init --adopt`); `--adopt` adopts a hand-built repo end-to-end (audit exits
      0 after, modulo the inherent Gemini-fragment HH-W007); claude-only skills
      imported into `.agents/skills/`; an existing `.agents/instructions/<name>.md`
      that agrees with a `.github/instructions/<name>.instructions.md` collapses
      (EV1) with no clobber; one that disagrees surfaces a contradiction and, when
      resolved toward the provider, backs up the canonical original (AD6);
      `--adopt --dry-run` previews and writes nothing; `--adopt` on a non-canonical
      repo behaves as plain `init`.

## Out of scope

- A full **refresh** mode that re-runs adoption over an *already* tool-canonical
  repo to pull in newly-added provider files (e.g. a skill added to `.claude/`
  after onboarding). AD1 keeps refusing that case toward `apply`; a dedicated
  refresh flow is a future story.
- Reverse-engineering provider hook configs into canonical hooks (unchanged from
  C3 — surfaced as a note).
