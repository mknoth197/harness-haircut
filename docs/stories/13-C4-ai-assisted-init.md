# C4 — AI-assisted init merge (optional)

**Type:** Command (extends C3)
**Depends on:** C3 ([#13](https://github.com/mknoth197/harness-haircut/issues/13)) — reuses the injected `ContradictionResolver` seam
**Blocks:** none (optional, post-v1 capability)
**Labels:** `enhancement`, `command`, `ai-assist`

## Context

The deterministic engine compares **normalized text**. That is correct and required for `audit`/`apply`, but it makes `init`'s contradiction handling blunt in two ways the C3 review surfaced:

- **False contradictions** — two files that say the same thing in different words (e.g. `run tests with npm test` vs ``use `npm test` for the suite``) are flagged as a conflict, nagging the user.
- **Lossy resolution (C3 review F2)** — a genuine conflict is resolved by choosing one candidate and discarding the other's unique content (mitigated today only by a backup copy under `.harness-haircut-init-backup/`; the discarded content still never reaches canonical).

C4 adds an **optional** LLM "assist" that improves accuracy on exactly these fuzzy, one-time, human-supervised tasks: judging *semantic* equivalence, and proposing a *merged* canonical text instead of forcing a pick. It is governed by the **determinism boundary** in [PRD §17](../PRD.md): an LLM runs **only** under `init --assist`, the human approves every write, and the output becomes ordinary frozen canonical markdown that the deterministic core then owns — so idempotency and SignedSource semantics are untouched. Implementation is a layer-3 gateway implementing the `ContradictionResolver` interface C3 already injects; entities and use-cases stay SDK-free.

## Requirements (EARS)

- **U1.** The package shall provide an optional `aiResolver` implementing the existing `ContradictionResolver` interface, selected **only** when the user passes `init --assist` (or sets `init.assist: true` in `harness-haircut.config.json`) AND a provider credential is available; otherwise `init` shall use the deterministic resolver with no behavior change.
- **U2.** The provider SDK shall be an **optional/peer dependency**, dynamically imported only when the assist resolver is activated. A default install and the entire `audit` / `apply` / `doctor` / `install-precommit` path shall never load a provider SDK (PRD Goal 5 preserved).
- **U3.** An LLM shall be invoked **only** from `init --assist`. No other command — and nothing reachable from CI, pre-commit hooks, `audit`, or `apply` — shall make a model call.
- **EV1.** When two candidate texts are semantically equivalent (per the AI judge), the resolver shall report agreement and the command shall **not** prompt for that slot (fewer false contradictions than the deterministic comparer).
- **EV2.** When candidates genuinely differ, the resolver shall propose a single **merged** canonical text; the command shall display the proposal as a diff and require explicit human approval before writing it. Declining shall fall back to the deterministic choose-A / choose-B / skip flow (C3 behavior).
- **EV3.** Before any file content is sent to a provider API, the command shall display an **egress disclosure** naming the destination provider and the files involved, and require explicit consent. Consent may be remembered for the run (or persisted via config); absent consent, nothing is sent.
- **EV4.** When AI-proposed merged content is approved, the command shall write it as ordinary canonical markdown; from that point the deterministic engine owns it and no LLM is re-invoked by `apply`/`audit` (idempotency preserved).
- **OPT1.** Where `--assist` is requested but no credential / no network is available, the command shall, per `init.assist.onUnavailable` config (`fallback` | `fail`), either fall back to the deterministic resolver with a warning (default) or exit non-zero with an actionable message.
- **OPT2.** Where `--assist` is combined with `--non-interactive`, the command shall fail closed with exit 1 (AI merges require human approval per EV2, which `--non-interactive` cannot provide) — never auto-accept AI output unattended.
- **UN1.** If a provider API call errors, times out, or is rate-limited, then the command shall fall back to the deterministic resolver for the affected slot with a warning and shall never crash or block `init`.
- **UN2.** If `--assist` is requested while the optional provider SDK is not installed, then the command shall exit 3 with an actionable message (how to install / which env var to set), not crash.
- **UN3.** If the egress consent (EV3) is declined, then assist shall be disabled for the run, the deterministic resolver used, and nothing transmitted.

## Acceptance criteria

- [ ] `aiResolver` lives in a layer-3 gateway (e.g. `src/gateways/ai-resolver.ts`) implementing the `ContradictionResolver` interface from `src/entities/`. Entities and use-cases import **no** provider SDK (verified by grep/dependency check).
- [ ] Provider SDK declared under `optionalDependencies` (or `peerDependencies` + a clear install hint); `npm ci` without it still builds and passes the full suite; the SDK is `import()`-ed lazily only inside the assist path.
- [ ] `init` use case is unchanged in shape — it still takes an injected `ContradictionResolver`; only `cli.ts` (composition root) decides which implementation to wire.
- [ ] Egress disclosure text + a config flag to remember consent; a redaction/allowlist hook is noted for a follow-up (not required here).
- [ ] Tests (offline — **no live network**): a fake AI resolver drives the use case through EV1/EV2/EV4; egress-consent gating (EV3/UN3); fallback-on-error (UN1) and fallback-on-no-credential (OPT1); `--assist --non-interactive` fails closed (OPT2); SDK-absent → exit 3 (UN2). Any real SDK call is stubbed.
- [ ] `doctor` reports whether assist is available (credential present, SDK installed) without making a call.
- [ ] PRD §17 determinism boundary honored: a test asserts no provider SDK module is loaded on an `audit`/`apply` run.

## Out of scope

- LLM involvement anywhere in `audit`/`apply`/CI/hooks (forbidden by the PRD §17 determinism boundary).
- AI rewriting of lossy translations (`HH-W001` globs, unmapped hook events) — risky (could silently change meaning); a separate future consideration, kept as loud warnings for now.
- Auto-merging without human approval; unattended/`--non-interactive` assist.
- Reverse-engineering provider **hook** configs into canonical hooks (still the informational note from C3).
- A provider-agnostic prompt-quality/eval harness for the merge prompt (future).

## Notes / open questions

- Default provider for assist (Anthropic, given the canonical format's lineage) vs. user-selected — config key `init.assist.provider`.
- Whether to support reusing an installed provider CLI's authed session (subscription, no API key) as an alternative credential source — opt-in only, since it reintroduces a provider-tool dependency.
