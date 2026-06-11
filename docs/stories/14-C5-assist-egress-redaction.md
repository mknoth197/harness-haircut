# C5 — assist egress redaction & guardrails

**Type:** Security gate for C4 (the `--assist` egress path)
**Depends on:** C4 ([#28](https://github.com/mknoth197/harness-haircut/issues/28)) types/seam
**Blocks:** the `--assist` egress path may not ship until this lands
**Labels:** `enhancement`, `security`, `ai-assist`

## Context

A Fable security/pen-test pass ([`docs/security/assist-egress-threat-model.md`](../security/assist-egress-threat-model.md), 2026-06-11) found that sending the canonical/provider trees to a third party is unsafe without a policy: those files plausibly hold secrets (tokens in hook scripts, MCP URLs in settings JSON), internal hostnames, proprietary commands, and PII — a real concern on corporate/regulated machines. It also found that shelling a provider CLI **inside the repo** both balloons egress and **executes the repo's hooks/MCP (arbitrary code)**. C5 is the guardrail layer that must exist before C4's egress path ships.

## Requirements (EARS)

- **U1 (default-deny by file class).** Egress shall be allowed by default only for instruction **prose** (`AGENTS.md` root+nested, `.agents/instructions/**`, `.github/instructions/**`, `.claude/rules/**`). `.agents/skills/**/SKILL.md` bodies shall be **opt-in**. Hook scripts (`.agents/hooks/**`), settings/hook JSON (`.claude/settings.json`, `.codex/hooks.json`, `.codex/config.toml`, `.gemini/settings.json`), skill sibling attachments, tool state/backups, unknown attachments, and non-UTF-8 files shall be **hard-denied**. The policy shall run on the resolver **candidate bytes** before any backend sees them.
- **U2 (secret scan, hard block).** Before any byte leaves, the content shall be scanned for high-confidence secrets (AWS keys, PEM private keys, JWTs, GitHub/GitLab/Slack/Google/OpenAI/Anthropic/npm tokens, high-entropy strings adjacent to `token|secret|password|api[_-]?key|credential`). A high-confidence match shall **hard-block the run** by default, naming file + line + rule.
- **EV1.** When the user passes `--assist-include <glob>`, a hard-denied class becomes eligible, and every included file shall be individually enumerated in the disclosure (U4).
- **EV2.** When a secret matches and the user passes `--assist-allow-secret <rule>`, the matched span shall be **redacted** to a stable `[REDACTED:<rule>]` placeholder before send (shown in the preview) rather than blocking. Default remains block.
- **EV3 (no CLI amplification — Finding 1).** When the subscription-session backend invokes a provider CLI, it shall spawn with `cwd` set to an **empty scratch directory** (never inside the repo), pass content only via prompt/stdin, and use the provider's "ignore project config" flag where one exists. A provider whose headless mode cannot avoid auto-loading project context without a credential the user did not select shall have its **subscription-session backend disabled** for `--assist`.
- **EV4 (consent preview).** Before any byte leaves, the command shall print (non-suppressible even when consent is remembered): destination provider + resolved model + credential-source kind; the **exact file list with per-file and total byte counts**; the vendor retention/training caveat; the secret-scan summary; and a **default-on preview of the exact post-redaction bytes** (`--no-preview` suppresses the body, never the file list/counts). Consent shall be an explicit affirmative.
- **OPT1 (regulated default-off).** Where `harness-haircut.config.json` sets `init.assist.endpointPolicy: "approved-only"` (recommended default for corporate installs), `--assist` shall refuse any provider/endpoint not on the configured allowlist.
- **UN1.** If the secret scan errors or a file is unreadable, then egress shall fail closed (block), never send-on-error.
- **UN2.** If `--no-preview` is combined with `--assist-yes`/remembered consent, the file list + byte counts + secret summary shall still print (auditability), even though the body preview is suppressed.

## Acceptance criteria

- [ ] Pure egress-policy module in entities (e.g. `src/entities/egress-policy.ts`): classify a canonical/candidate path → `allow | opt-in | deny`; pure secret-scan over bytes → findings. No I/O.
- [ ] Secret-scan rule set with per-rule severity + a config to extend/suppress rules; high-confidence default = block.
- [ ] The scratch-cwd/bare CLI invocation (EV3) implemented in the C4 CLI-session gateway; a test asserts the spawn `cwd` is **not** under the repo root and the ignore-project flag is passed.
- [ ] Consent preview renderer (EV4) with byte-accurate file list; `--no-preview` / `--assist-yes` semantics per UN2.
- [ ] Tests (offline): default-deny matrix per class; secret-scan hard-block + `--assist-allow-secret` redaction; `--assist-include` enumeration; fail-closed on scan error; scratch-cwd assertion; approved-only endpoint refusal.

## Out of scope

- The merge logic itself (C4).
- ML-based secret detection (regex + entropy only in v1).
- Redacting *within* the merged result that gets written back (we redact what is **sent**; the canonical output is the user's own content).

## Notes

C4's egress path (U5 subscription-session backend and the SDK backend) MUST NOT ship until C5's U1/U2/EV3/EV4 are in place — recorded as a hard dependency in C4.
