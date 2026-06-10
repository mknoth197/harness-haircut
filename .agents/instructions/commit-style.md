---
scope: "**/*"
---

# Commit & PR style

[Conventional Commits](https://www.conventionalcommits.org/) — strictly enforced once a `commitlint` hook lands (I1 [#14](https://github.com/mknoth197/harness-haircut/issues/14)). Until then, follow the rules below by hand.

## Subject line

Format: `<type>: <imperative subject>` — max **72 characters**.

`<type>` is one of:

| Type | Use for |
|---|---|
| `feat` | New user-facing capability |
| `fix` | Bug fix (incl. regressions) |
| `docs` | Documentation only |
| `refactor` | Restructure with no behavior change |
| `test` | Tests only |
| `build` | Build system / packaging |
| `ci` | CI workflow / scripts |
| `chore` | Anything that doesn't fit above (dep bumps, repo hygiene) |

Examples:

```
feat: add SignedSource header verifier
fix: reject --cwd / --config when value is missing
refactor: split bin.ts from cli.ts
docs: fill PRD §6-14 with v1 defaults
ci: build before typecheck to satisfy test-file dist/ import
```

`<scope>` is optional and may be a layer or module name: `feat(adapters): add codex adapter`.

## Body

- Explain **why**, not **what** (the diff already shows what).
- Wrap at ~72 chars.
- Bullets are fine; full sentences are fine; both is fine.
- Include alternatives considered + reasoning when the choice is non-obvious.

## Footers

- **Refs:** `Refs: #N` for related issues this commit advances but does not close.
- **Closes:** `Closes: #N` (Github auto-closes the issue when the commit lands on default branch).
- **Co-authored:** `Co-Authored-By: Name <email>` (one per line).
- **BREAKING CHANGE:** `BREAKING CHANGE: <description>` only when shipping a v1.0+ binary-incompatible change. v0.x can break freely.

## One commit per logical change

- A commit should be reviewable in isolation: lint passes, tests pass, build works.
- If a change requires multiple file groups (e.g., a feature + its tests + docs), one commit covering all three is fine *if* they form a single logical unit. Split when the units have independent value.
- Don't bundle unrelated fixes ("drive-bys"). Open a follow-up issue instead.

## PR style

- Title mirrors the lead commit's subject. Adding `(closes #N)` at the end is fine.
- Description has three sections:
  1. **Summary** — 1-3 bullets, what the PR does and why.
  2. **Spec alignment** — explicit mapping from PR contents to the EARS rules / PRD sections it satisfies. Cite file paths and line numbers.
  3. **Test plan** — checklist of what was verified (commands run, paths exercised). Reviewer todos go here, marked with `[ ]`.
- PRs that touch architecture or the canonical format require a written rationale and a link to the issue that authorized the change.

## What's NOT in a commit

- Generated files that aren't gitignored — never. Add the path to `.gitignore` first.
- Commented-out code. Delete it; git remembers.
- TODOs without a tracking issue. `// TODO(#N): …` is OK; bare `// TODO:` is not.
- Secrets. Ever. Rotate immediately if you slip.
