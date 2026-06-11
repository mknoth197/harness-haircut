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

**Credential discovery, not an assumed default.** Rather than hard-coding a provider, `init --assist` **discovers** which AI credential sources are actually available on the machine and **proposes** them for the user to choose. Two source kinds are supported (verified per provider in [the matrix](../research/provider-matrix.md#ai-assist-credential-sources--cli-headless-modes--subscription-sessions)):
1. **Env API key** — `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `GEMINI_API_KEY`|`GOOGLE_API_KEY` (deterministic, CI-safe).
2. **Subscription session** — reuse an already-logged-in provider CLI's headless mode (`claude -p`, `codex exec`, `gemini -p`, `copilot -p`) so the user's existing Pro/Max/Plus/Copilot subscription is the credential, **no API key required**.

Discovery is **paid-call-free**: probe the binary on PATH, then an env key, then an authed-session file/keychain (preferring a status subcommand where one exists — only `codex login status` gives a clean exit-code). Each available source is presented **with its ToS/feasibility caveat** (Claude `claude -p` is explicitly sanctioned via the Agent SDK credit; Codex/Gemini work but vendors prefer keys for automation; Copilot is subscription-only with no JSON output) and the user picks. Nothing is assumed and nothing runs without an explicit choice.

## Requirements (EARS)

- **U1.** The package shall provide an optional `aiResolver` implementing the existing `ContradictionResolver` interface, selected **only** when the user passes `init --assist` (or sets `init.assist: true` in `harness-haircut.config.json`) AND the user selects an available credential source (U4); otherwise `init` shall use the deterministic resolver with no behavior change.
- **U2.** The provider SDK and any provider-CLI invocation shall be **optional**: the SDK is a peer/optional dependency dynamically imported only when an API-key source is chosen, and a provider CLI is shelled out to only when a subscription-session source is chosen. A default install and the entire `audit` / `apply` / `doctor` / `install-precommit` path shall never load a provider SDK or invoke a provider CLI (PRD Goal 5 preserved).
- **U3.** An LLM shall be invoked **only** from `init --assist`. No other command — and nothing reachable from CI, pre-commit hooks, `audit`, or `apply` — shall make a model call.
- **U4 (discovery).** `init --assist` shall run a **paid-call-free discovery** that probes each provider for: (a) the CLI binary on PATH, (b) an env API key, (c) an authenticated subscription session (session file/keychain presence, or a status subcommand where available, e.g. `codex login status`). It shall present **every** discovered source to the user — each labeled with provider, source kind (api-key | subscription-session), and its ToS/feasibility caveat — and let the user choose. No provider is assumed as a default; if exactly one source exists the command shall still confirm it, not auto-run.
- **U5 (subscription session).** When the user selects a subscription-session source, the assist call shall be made by invoking that provider's CLI headless mode against the user's logged-in session (`claude -p` / `codex exec` / `gemini -p` / `copilot -p`, structured-output flag where the CLI supports one; Copilot is text-only), with **no API key required**. The invocation shall be a single non-interactive call with a bounded timeout.
- **EV1.** When two candidate texts are semantically equivalent (per the AI judge), the resolver shall report agreement and the command shall **not** prompt for that slot (fewer false contradictions than the deterministic comparer).
- **EV2.** When candidates genuinely differ, the resolver shall propose a single **merged** canonical text; the command shall display the proposal as a diff and require explicit human approval before writing it. Declining shall fall back to the deterministic choose-A / choose-B / skip flow (C3 behavior).
- **EV3.** Before any file content is sent to a provider (API or CLI session), the command shall display an **egress disclosure** naming the destination provider, the credential source chosen, and the files involved, and require explicit consent. Consent may be remembered for the run (or persisted via config); absent consent, nothing is sent.
- **EV4.** When AI-proposed merged content is approved, the command shall write it as ordinary canonical markdown; from that point the deterministic engine owns it and no LLM is re-invoked by `apply`/`audit` (idempotency preserved).
- **EV5 (caveat surfacing).** When a selected source carries a ToS/metering caveat (subscription metering, vendor-prefers-key, Copilot premium-request consumption, Gemini consumer-auth sunset), the command shall display that caveat before the first call.
- **OPT1.** Where `--assist` is requested but discovery finds **no** source, the command shall, per `init.assist.onUnavailable` config (`fallback` | `fail`), either fall back to the deterministic resolver with a warning (default) or exit non-zero with an actionable message naming what to install or which env var to set.
- **OPT2.** Where `--assist` is combined with `--non-interactive`, the command shall fail closed with exit 1 (discovery proposal + AI-merge approval both require human interaction) — never auto-select a source or auto-accept AI output unattended.
- **UN1.** If a provider API/CLI call errors, times out, is rate-limited, or (for a subscription session) the CLI reports not-logged-in/over-quota, then the command shall fall back to the deterministic resolver for the affected slot with a warning and shall never crash or block `init`.
- **UN2.** If an API-key source is chosen while the optional provider SDK is not installed — or a subscription-session source is chosen while the CLI binary is absent — then the command shall exit 3 with an actionable message, not crash. (Discovery U4 should normally prevent offering an unavailable source.)
- **UN3.** If the egress consent (EV3) is declined, then assist shall be disabled for the run, the deterministic resolver used, and nothing transmitted.

## Acceptance criteria

- [ ] A pure **credential-discovery** module in a gateway (e.g. `src/gateways/ai-credentials.ts`) that probes PATH binaries, env keys, and authed-session markers and returns a ranked, caveat-annotated list of `CredentialSource`s — **without making any model call**. The probe interface is injectable so tests run offline.
- [ ] `aiResolver` lives in a layer-3 gateway (e.g. `src/gateways/ai-resolver.ts`) implementing the `ContradictionResolver` interface from `src/entities/`, with two backends — SDK (api-key) and CLI-headless (subscription-session). Entities and use-cases import **no** provider SDK and shell out to **no** CLI (verified by grep/dependency check).
- [ ] Provider SDK declared under `optionalDependencies` (or `peerDependencies` + a clear install hint); `npm ci` without it still builds and passes the full suite; the SDK is `import()`-ed lazily only inside the api-key backend. The CLI-headless backend uses `execFile` (no SDK).
- [ ] `init` use case is unchanged in shape — it still takes an injected `ContradictionResolver`; only `cli.ts` (composition root) runs discovery, presents sources, and wires the chosen backend.
- [ ] Egress disclosure text names the chosen source + caveat (EV3/EV5) + a config flag to remember consent; a redaction/allowlist hook is noted for a follow-up (not required here).
- [ ] Tests (offline — **no live network, no real CLI calls**): a fake discovery probe + fake resolver drive the use case through U4 (propose multiple sources, user selects), EV1/EV2/EV4/EV5; egress-consent gating (EV3/UN3); fallback-on-error and CLI not-logged-in/over-quota (UN1); no-source fallback/fail (OPT1); `--assist --non-interactive` fails closed (OPT2); SDK-absent / CLI-absent → exit 3 (UN2). Any real SDK or CLI invocation is stubbed/injected.
- [ ] `doctor` reports the discovered credential sources (provider, kind, caveat) without making a call — reusing the same discovery module.
- [ ] PRD §17 determinism boundary honored: a test asserts no provider SDK module is loaded and no provider CLI is spawned on an `audit`/`apply` run.

## Out of scope

- LLM involvement anywhere in `audit`/`apply`/CI/hooks (forbidden by the PRD §17 determinism boundary).
- AI rewriting of lossy translations (`HH-W001` globs, unmapped hook events) — risky (could silently change meaning); a separate future consideration, kept as loud warnings for now.
- Auto-merging without human approval; unattended/`--non-interactive` assist.
- Reverse-engineering provider **hook** configs into canonical hooks (still the informational note from C3).
- A provider-agnostic prompt-quality/eval harness for the merge prompt (future).
- *Managing* provider CLI login (we detect and reuse an existing session; we never run `claude /login`, `codex login`, etc. on the user's behalf — if not logged in, we say so and offer the other discovered sources).

## Resolved decisions (were open questions)

- **No assumed default provider.** Replaced by discovery + propose (U4): `init --assist` detects available sources and the user chooses. A `init.assist.provider` config key may *pre-select* a preferred provider but never silently overrides discovery.
- **Subscription session is supported** as a first-class credential source (U5), opt-in. Verified feasible for all four CLIs ([matrix](../research/provider-matrix.md#ai-assist-credential-sources--cli-headless-modes--subscription-sessions)); it reintroduces only an *optional* provider-CLI dependency, invoked solely on the assist path. Caveats are surfaced to the user (EV5): Claude `claude -p` is explicitly sanctioned (Agent SDK credit, eff. 2026-06-15); Codex/Gemini work but vendors prefer keys for automation and meter usage; Copilot is subscription-only, text-output, and consumes premium requests.

## Model selection policy (decided)

The merge is a bounded text task that a human reviews before any write (EV2), so maximum capability is unnecessary — favor a fast, balanced tier and never pin a model id that will rot.

- **Subscription-session (CLI) backend:** pass **no `--model`** — use the provider CLI's own configured default. This respects the developer's existing CLI setup and avoids hard-coding ids (provider model names churn fast — see the matrix's Codex/Gemini/Copilot rename history).
- **Env-API-key (SDK) backend:** default to each provider's **balanced mid-tier** model, held in a single per-provider constant that is trivial to bump as ids change (examples as of 2026-06: Anthropic `claude-sonnet-4-6`, OpenAI a balanced GPT-5.x tier, Google a Gemini Flash/Pro balanced tier). Not the flagship.
- **Always show the resolved model** (and source) in the egress disclosure (EV3/EV5) before the call.
- **Override:** `init.assist.model` (config) or `--assist-model <id>` (flag) overrides either backend.

## Credential-choice persistence (decided)

A remembered credential-source choice persists **per-machine, user-local** — NOT in the team-shared `harness-haircut.config.json`. Credentials and CLI sessions are per-developer, so a committed choice would be wrong (or leak intent) for teammates. Store it in a user-local, gitignored location (e.g. `~/.config/harness-haircut/assist.json` or an explicitly gitignored `harness-haircut.local.json`); never write a credential value, only the chosen *source kind + provider*. The team-shared config may carry non-secret policy (`init.assist: true`, `init.assist.onUnavailable`) but never the per-developer selection.

## Remaining open questions

- **Redaction / allowlist of which file contents may be sent** — scoped by the Fable pen-test ([`docs/security/assist-egress-threat-model.md`](../security/assist-egress-threat-model.md)) and specified in **C5** ([`14-C5-assist-egress-redaction.md`](14-C5-assist-egress-redaction.md), [#30](https://github.com/mknoth197/harness-haircut/issues/30)). **C4's egress path (U5 + the SDK backend) is a HARD dependency on C5** — it must not ship until C5's default-deny classes, secret-scan-hard-block, scratch-cwd/bare CLI invocation, and byte-accurate consent preview are in place. The pen-test also found a v1 issue independent of assist (a symlink-following reader in `init`) being fixed separately.
