# Threat model — `init --assist` egress & v1 attack surface

**Source:** Fable security/pen-test pass, 2026-06-11 (static analysis + threat modeling; no live exploitation). Scope: the not-yet-built `init --assist` egress feature (PRD §17, story C4) plus the merged v1 attack surface. This document is the rationale for story **C5 (assist egress redaction)** and for the v1 security-hardening fixes.

## Why egress needs a policy

`--assist` would send file *contents* to a third party. On a corporate/regulated machine the canonical and provider trees plausibly contain secrets (tokens in hook scripts, MCP server URLs in settings JSON), internal hostnames, proprietary build/deploy commands, and PII. Sending the whole tree is unacceptable; the feature must default-deny and prove (byte-accurate) what leaves.

## Default-deny per file class (C5)

| Class | Egress default | Why |
|---|---|---|
| `AGENTS.md` (root+nested), root `CLAUDE.md`/`GEMINI.md`/`.github/copilot-instructions.md`, `.agents/instructions/**`, `.github/instructions/**`, `.claude/rules/**` | **ALLOW** (prose) | The only thing the merge reasons about. `CLAUDE.md`/`GEMINI.md` are root-only shims — a *nested* `CLAUDE.md`/`GEMINI.md` is not a thing this tool emits, so it is **not** prose-by-path (it denies via the catch-all). |
| `{.agents,.claude,.codex}/skills/<name>/SKILL.md` body | **OPT-IN** | Skill bodies embed example calls / internal URLs / tokens. |
| `**/skills/**` sibling attachments | **HARD DENY** | Scripts/assets/`.env`; highest secret density. Classification is **segment-aware**: any path through a `skills`/`hooks` directory, or through a `.harness-haircut-init-backup` segment at any depth, hard-denies regardless of a prose-looking basename. |
| `.agents/hooks/**` (`*.sh`,`*.js`) | **HARD DENY** | Executable; deploy creds, internal hosts. |
| `.claude/settings.json`, `.codex/hooks.json`, `.codex/config.toml`, `.gemini/settings.json` | **HARD DENY** | env / tokens / MCP URLs. |
| `.agents/.harness-state.json`, `.harness-haircut-init-backup/**` | **HARD DENY** | Tool bookkeeping / unchosen backups. |
| unknown attachment / non-UTF-8 | **HARD DENY** | Default-deny catch-all. |

Enforce on the **resolver candidate bytes** (`root-instructions`/`fragment:*` = prose → allow; `skill:*` = SKILL.md body → opt-in), before any backend sees them. `--assist-include <glob>` is the only way to send a denied class, and every included file is enumerated in the disclosure.

## Secret scan before send — hard block by default (C5)

Runs on **every byte that would leave** (an allowlisted `AGENTS.md` can still carry a token — this very repo's docs reference a corporate email, `CLAUDE_TOKEN`, an internal CA). High-confidence rules hard-block the run (AWS `AKIA…`, PEM private keys, JWT, `ghp_/gho_/…`, `glpat-`, Slack `xox*`, Google `AIza…`, OpenAI `sk-…`, Anthropic `sk-ant-…`, npm tokens, long hex secrets and high-entropy strings adjacent to `token|secret|passwd|password|api[_-]?key|credential`). Medium (internal IPs/hosts, emails) → WARN. `--assist-allow-secret <rule>` downgrades block → redaction with a stable `[REDACTED:<rule>]` placeholder. Default is block, not redact.

Detection is hardened against trivial evasion (C5 review): the shape rules match their distinctive prefix even when a token is glued immediately after a word char (no leading `\b`); a normalization pre-pass strips invisible splitters (`\p{Cf}` zero-width, `\p{M}` marks, control chars) so they can't break a token, and folds lookalike letters to their ASCII skeleton — NFKC for compatibility confusables (fullwidth `Ａ`, mathematical `𝐀`) plus a curated Cyrillic/Greek homoglyph map (`А`→`A`, `І`→`I`) that NFKC leaves untouched — so a credential a human reads as `AKIA…` is matched as `AKIA…`; keyword adjacency spans the candidate's line **plus the line above** with LF/CRLF/CR normalized; and a dedicated long-hex rule catches 64-hex CI tokens that sit just under the entropy floor. (A confusable outside the curated homoglyph set is the residual limit of a regex scanner, but the fold only ever turns a lookalike INTO ASCII, so the worst case is an over-block — never a hidden secret.)

## CLI-session must not amplify (Finding 1 — High)

Shelling a provider CLI (`claude -p` / `codex exec` / `gemini -p` / `copilot -p`) **inside the repo** makes it auto-load the repo's own `CLAUDE.md`/`@AGENTS.md`/`.claude/skills`/`.claude/settings.json` hooks/`.mcp.json` → (a) egress far beyond the candidate texts and (b) **execution of the repo's hooks/MCP servers (arbitrary code)** when onboarding an untrusted repo. Mandatory mitigations: spawn with `cwd` = an empty scratch dir (never the repo), pass content only via prompt/stdin, use each CLI's "ignore project config" flag (Claude `--bare` — but it needs an API key, so a Claude *subscription* session can't be bare → disable subscription backends that cannot run without auto-loading project context), strip behavior-changing env, bounded timeout.

## Consent / disclosure (strengthen EV3/EV5 in C5)

Before any byte leaves, print (non-suppressible): destination provider + resolved model + credential-source kind; **exact file list with per-file + total byte counts**; the vendor retention/training caveat; secret-scan summary; and a **default-ON preview of the exact post-redaction bytes** (`--no-preview` to suppress). Consent is an explicit affirmative; remembering the *decision* still prints the file list for auditability.

## Channel guidance

An **org-approved enterprise API key under zero-retention/no-train terms is the safer channel** (single-purpose, contractually governed, no project-config amplification) than a consumer subscription/CLI session. **On regulated/corporate machines, default the whole feature OFF** and allow it only against an organizationally approved endpoint (BYO / Bedrock / Vertex).

## v1 attack-surface findings (independent of `--assist`)

| # | Sev | Location | Scenario | Fix |
|---|---|---|---|---|
| 2 | **Med (now) / High (with assist)** | `src/gateways/provider-files.ts` reader follows symlinks; reached by `init` reading `CLAUDE.md`/`GEMINI.md`/`AGENTS.md`/`.github/copilot-instructions.md` | Repo with `CLAUDE.md` → `~/.ssh/id_rsa` recovers that content into canonical `AGENTS.md` → projected/committed (and egressed once assist ships). | Reject symlinks (lstat) in `createProviderFileReader`, or source `init` candidates from the symlink-skipping snapshot. |
| 4 | Low | `init` writes skill/fragment names (`init.ts`) without the `SKILL_NAME_RE` guard `parse-repo` enforces; `fs-writer` has no root-containment assert | Out-of-`^[a-z0-9-]+$` name → partial write then apply-time exit 3 → dirty tree. No traversal today. | Validate names in `init` before write; add `resolve()`+`startsWith(root+sep)` in `createFileWriter`. |
| 5 | Info | `apply.ts` `setOwnedValue` splits mergeKey on `.` without guarding `__proto__`/`constructor` | Safe today (constant keys); latent proto-pollution if a future adapter derives mergeKey from content. | Reject `__proto__`/`constructor`/`prototype` segments. |
| 3 | Low–Med | `filesystem.ts` glob→regex | Crafted root `.gitignore` (untrusted repo) with many `*` segments → polynomial backtracking. Bounded by path length; slowdown, not RCE. | Cap pattern length / wildcard count. |
| 6 | Info | `install-precommit` hook runs `npx harness-haircut audit` | `npx` prefers repo-local `node_modules/.bin` → a malicious repo could shadow the binary. User installs deliberately; `audit` read-only. | Optionally pin version / absolute path. |

**Confirmed safe (no action):** no shell anywhere (execFile + array args; static hook content); hook-basename + skill-name injection guards present; frontmatter uses `Object.create(null)`; walk skips symlinks + `.git`/`node_modules`/`dist`; SignedSource truncation is non-adversarial (full byte-equality also checked); release workflow pins action SHAs, scopes the token to publish, fail-closed tag regex, `--provenance`, no secret echoed.

## Top 3 before `--assist` ships
1. CLI-session amplification + code execution (Finding 1) — scratch-cwd/bare invocation; disable un-bareable subscription backends.
2. Land the C5 egress policy (default-deny + secret-scan-hard-block + byte-accurate preview) as a hard dependency of the egress path.
3. Symlink-following reader (Finding 2) — fix regardless of assist.
