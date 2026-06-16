# EARS user stories — `harness-haircut` v1

Each file in this directory is one user story written in EARS syntax (Easy Approach to Requirements Syntax). They are intended to become individual GitHub issues — see [`scripts/create-ears-issues.sh`](../../scripts/create-ears-issues.sh) for a script that creates them via `gh`.

> **Why are these in the repo and not GitHub issues?** The session that drafted them ran under an Enterprise Managed User auth that's denied write access to `mknoth197/*`. The script lets the repo owner create the issues from their own auth.

## Dependency chain

```
                            ┌────────────────────┐
                            │ F0 Project scaffold│   ← foundational; start here
                            └──────────┬─────────┘
                                       │
                ┌──────────────────────┼──────────────────────┐
                ▼                      ▼                      ▼
        ┌──────────────┐      ┌──────────────┐      ┌──────────────────────┐
        │ F1 IR/parser │      │ F2 SignedSrc │      │ F3 Adapter interface │
        └──────┬───────┘      └──────┬───────┘      └──────────┬───────────┘
               │                     │                         │
               │                     │       ┌─────────────────┴─────┐
               │                     │       │                       │
               │                     │       ▼                       ▼
               │                     │   (uses F1)              (uses F1+F3)
               │                     │       │                       │
               └─────────────────────┼───────┴───────┬───────┬───────┴───────┐
                                     │               │       │       │      │
                                     │               ▼       ▼       ▼      ▼
                                     │           ┌───────┬───────┬───────┬───────┐
                                     │           │ A1    │ A2    │ A3    │ A4    │
                                     │           │ Codex │ Claude│ Gemini│ Copilot│
                                     │           └───┬───┴───┬───┴───┬───┴───┬───┘
                                     │               └───────┴───┬───┴───────┘
                                     │                           ▼
                                     │                   ┌──────────────┐
                                     └──────────────────▶│ C1 audit     │
                                                         └──────┬───────┘
                                                                ▼
                                                         ┌──────────────┐
                                                         │ C2 apply     │ (also needs F2)
                                                         └──────┬───────┘
                                                                ▼
                                                         ┌──────────────┐
                                                         │ C3 init      │
                                                         └──────┬───────┘
                                                                ▼
                                                         ┌──────────────┐
                                                         │ I1 CI integ. │
                                                         └──────┬───────┘
                                                                ▼
                                                         ┌──────────────┐
                                                         │ I2 npm dist. │ (release gate)
                                                         └──────────────┘
```

## Story list

| Order | ID | Title | Depends on |
|---|---|---|---|
| 1 | F0 | [Project scaffold and CLI entry point](00-F0-project-scaffold.md) | — |
| 1.5 | F0.5 | [Project standards & dogfood AGENTS.md](00b-F0.5-project-standards.md) | F0 |
| 2 | F1 | [Canonical IR types and parser](01-F1-canonical-ir.md) | F0 |
| 3 | F2 | [SignedSource header generator and verifier](02-F2-signedsource-header.md) | F0 |
| 4 | F3 | [Provider adapter interface and registry](03-F3-provider-adapter-interface.md) | F0, F1 |
| 5 | A1 | [OpenAI Codex adapter](04-A1-codex-adapter.md) | F1, F3 |
| 6 | A2 | [Claude Code adapter](05-A2-claude-adapter.md) | F1, F3 |
| 7 | A3 | [Google Gemini CLI adapter](06-A3-gemini-adapter.md) | F1, F3 |
| 8 | A4 | [GitHub Copilot adapter](07-A4-copilot-adapter.md) | F1, F3 |
| 9 | C1 | [`audit` command](08-C1-audit-command.md) | F1, F3, ≥1 adapter |
| 10 | C2 | [`apply` command](09-C2-apply-command.md) | F1, F2, F3, all adapters |
| 11 | C3 | [`init` command](10-C3-init-command.md) | F1, F3, all adapters, C2 |
| 12 | I1 | [CI integration](11-I1-ci-integration.md) | C1, C2 |
| 13 | I2 | [npm distribution](12-I2-npm-distribution.md) | everything |
| 14 | C4 | [AI-assisted init merge (optional, post-v1)](13-C4-ai-assisted-init.md) | C3 |
| 15 | C5 | [Assist egress redaction & guardrails (security gate for C4)](14-C5-assist-egress-redaction.md) | C4 |
| 16 | C6 | [`init --adopt` (adopt a hand-built canonical repo)](15-C6-init-adopt-canonical.md) | C3, C4 |

## Parallelization notes

- After F0 lands, **F1, F2, F3** can be picked up in parallel by three contributors.
- After F3 lands, **A1, A2, A3, A4** are fully independent of each other.
- C1 only needs *one* adapter to be useful — A1 (Codex) is the smallest and the recommended unblocker.
- I2 is the release gate; everything else closes before it.

## Foundational story

**F0 (Project scaffold)** is the foundational story. A first-stab implementation has been committed on this branch — see the repo root for `package.json`, `tsconfig.json`, `src/cli.ts`, `src/index.ts`, and `test/cli.test.ts`.
