# Provider configuration matrix (verified)

**Researched:** 2026-06-10, via a 10-agent workflow (6 domain researchers + 4 adversarial verifiers, all against current official documentation). Every fact below carries a source. Confidence is `official-docs` unless marked otherwise. This document supersedes the assumptions in PRD §5/§10 v0.2 and is the normative input for the F1/F3 IR design and the A1–A4 adapters.

**Provider doc versions checked:** Claude Code v2.1.170 · Codex docs June 2026 (hooks GA 2026-05-14) · Gemini CLI v0.45.0 · Copilot docs June 2026.

---

## The headline: `.agents/` is becoming the de-facto standard — and that changes our adapters

Three of our four target providers **natively read `.agents/skills/`** as a skills location:

| Provider | Reads canonical `.agents/skills/` natively? | Source |
|---|---|---|
| OpenAI Codex | ✅ — current docs list `.agents/skills` (every dir from cwd → repo root), `~/.agents/skills`, `/etc/codex/skills`. `.codex/skills` is the *legacy* launch-era location, no longer in discovery docs | [developers.openai.com/codex/skills](https://developers.openai.com/codex/skills) |
| Gemini CLI | ✅ — `.agents/skills/` is a documented alias that **takes precedence over** `.gemini/skills/` (likewise `~/.agents/skills/`) | [geminicli.com/docs/cli/skills](https://geminicli.com/docs/cli/skills/) |
| GitHub Copilot | ✅ — searches `.github/skills/`, `.claude/skills/`, **and `.agents/skills/`** (since 2025-12-18, Agent Skills open standard) | [github.blog changelog](https://github.blog/changelog/2025-12-18-github-copilot-now-supports-agent-skills/) |
| Claude Code | ❌ — only `.claude/skills/` (project), `~/.claude/skills/` (personal), plugins | [code.claude.com/docs/en/skills](https://code.claude.com/docs/en/skills) |

**Consequence:** the skills adapter is a **no-op for Codex, Gemini, and Copilot** when canonical skills live in `.agents/skills/<name>/SKILL.md`. Only Claude needs a projection (`.claude/skills/`), and even that can be a symlink on POSIX. The PRD v0.2 table had this almost exactly backwards (it assumed `.codex/skills/` + `.gemini/skills/` projections and a Copilot "no equivalent" warning).

All four providers use the same **Agent Skills open standard** SKILL.md format ([agentskills.io](https://agentskills.io) lineage): YAML frontmatter with required `name` (lowercase-hyphenated) + `description`; optional `scripts/`, `references/`, `assets/` siblings. Provider-specific extras exist (Claude adds many optional keys; Codex adds `agents/openai.yaml`; Copilot adds `license`/`allowed-tools`) — the canonical format should stick to the common core.

---

## Instructions, per provider

### OpenAI Codex — native AGENTS.md (the reference implementation)

- Discovery: global `$CODEX_HOME/AGENTS.override.md` → `AGENTS.md` (first non-empty), then project-root **down to cwd**: at each level `AGENTS.override.md` → `AGENTS.md` → `project_doc_fallback_filenames`. ([guide](https://developers.openai.com/codex/guides/agents-md))
- Merge: **concatenated** root→cwd, blank-line joined; closer files override earlier guidance. Built **once per session**; files in subdirectories *below* cwd are **never** loaded dynamically.
- **32 KiB combined cap** (`project_doc_max_bytes`, default) — files silently stop being added past the cap. A consolidation tool that concatenates everything into root AGENTS.md can blow this.
- Repo-level config: `.codex/config.toml` **exists** ("Team Config", 2026-01-23), loaded only when the project is **trusted**. Keys ignored in project scope: `notify`, `profile`/`profiles`, `model_provider(s)`, base URLs, `otel`, etc.

### GitHub Copilot — three instruction layers, surface-dependent

1. `.github/copilot-instructions.md` — all surfaces (Chat, **code review**, cloud agent).
2. `.github/instructions/**.instructions.md` — frontmatter `applyTo` (comma-separated globs; `**`, `*`, `src/**/*.py` style; **no negation, no braces** documented) + `excludeAgent` (`code-review` | `cloud-agent`, Nov 2025). Nested subdirs allowed.
3. **`AGENTS.md` — natively read since 2025-08-28** by the coding/cloud agent: root + nested, "nearest file takes precedence", root = primary + nested = additional (i.e., *merge*, not pure nearest-wins). VS Code reads root AGENTS.md by default (`chat.useAgentsMdFile`), nested behind experimental `chat.useNestedAgentsMdFiles`. Also reads root `CLAUDE.md`/`GEMINI.md` as alternates. ([changelog](https://github.blog/changelog/2025-08-28-copilot-coding-agent-now-supports-agents-md-custom-instructions/))

⚠️ **Copilot code review does NOT read AGENTS.md** (June 2026, community-confirmed). To cover the code-review surface, `.github/copilot-instructions.md` (or `.instructions.md` files) must still be emitted. Precedence on github.com: Personal > Repository > Organization (concatenated; priority only resolves conflicts).

### Claude Code — CLAUDE.md still required; `@AGENTS.md` import is the blessed shim

- **AGENTS.md support has NOT shipped.** Docs verbatim: "Claude Code reads CLAUDE.md, not AGENTS.md." [anthropics/claude-code#6235](https://github.com/anthropics/claude-code/issues/6235) remains open, no milestone. ([memory docs](https://code.claude.com/docs/en/memory))
- **Official bridge:** a CLAUDE.md whose first line is `@AGENTS.md` (import), or a symlink (POSIX only; imports work on Windows). Imports resolve relative to the importing file, recurse ≤4 hops, load fully at launch. **This makes the Claude instructions projection a one-line file that never drifts** — far better than regenerating full content with SignedSource on every AGENTS.md edit.
- Load order: managed policy → `~/.claude/CLAUDE.md` → `./CLAUDE.md` or `./.claude/CLAUDE.md` → `CLAUDE.local.md`. Ancestors of cwd load at launch; subdirectory CLAUDE.md files load **on demand**.
- **`.claude/rules/*.md` with `paths:` glob frontmatter** (brace expansion supported, lazily loaded when matching files are touched) — the natural projection target for our scoped `.agents/instructions/*.md` files, much closer semantically than nested CLAUDE.md. Symlinks supported → zero-copy projection possible.
- Size guidance: ≤200 lines per CLAUDE.md (soft). HTML comments are stripped before context injection (relevant: our `@hand-emitted-projection` headers cost nothing).

### Gemini CLI — config-pointable, not native

- Default context file is hard-coded `GEMINI.md` (`DEFAULT_CONTEXT_FILENAME`, verified in source). AGENTS.md-by-default was **closed as not-planned** ([#12345](https://github.com/google-gemini/gemini-cli/issues/12345)).
- **`context.fileName`** (nested v2 schema key; `string | string[]`) in `.gemini/settings.json`: set to `["AGENTS.md", "GEMINI.md"]`. Setting it **replaces** the default — always include `GEMINI.md` if it should still load. Flat `contextFileName` is the deprecated v1 key (but still the spelling inside `gemini-extension.json` manifests).
- Alternative shim: `GEMINI.md` containing `@AGENTS.md` (import syntax, maxDepth 5, `.git`-bounded resolution, `tree`/`flat` import formats).
- Load hierarchy: `~/.gemini/GEMINI.md` + workspace + ancestors + just-in-time discovery on file access (`context.discoveryMaxDirs` default 200).
- ⚠️ Precedence quirk: **system settings override project settings** (`/etc/gemini-cli/settings.json` > `.gemini/settings.json`).

---

## Hooks, per provider — all four have them; the taxonomies differ

| | Repo location | Format | Events (repo-relevant) | Gates / quirks |
|---|---|---|---|---|
| **Claude Code** | `.claude/settings.json` `hooks` key (+ `settings.local.json`, skills/agents frontmatter, plugins) | `{event: [{matcher, hooks: [handler]}]}`; handler types `command`, `http`, `mcp_tool`, `prompt`, `agent` | **30 events** incl. SessionStart, **SessionEnd** (verifier-confirmed still documented), UserPromptSubmit, PreToolUse, PostToolUse, PostToolUseFailure, PermissionRequest, Stop, SubagentStart/Stop, PreCompact/PostCompact, Setup, FileChanged, … | Workspace trust required for project hooks; scopes **merge** (permission-style); matcher: exact / `\|`-list / regex; exit 2 = block |
| **Codex** | `.codex/hooks.json` (idiomatic) or `[hooks]` in `.codex/config.toml` | `{hooks: {Event: [{matcher, hooks: [{type:"command", command, commandWindows, timeout}]}]}}`; only `command` runs today | 10 PascalCase events: SessionStart, SubagentStart/Stop, PreToolUse, PermissionRequest, PostToolUse, PreCompact, PostCompact, UserPromptSubmit, Stop | **Enabled by default** (`[features] hooks = false` to disable — verifier-corrected). Project trust + **per-user hash-pinned trust via `/hooks`**: every re-projection re-triggers a trust prompt for every teammate. GA 2026-05-14 |
| **Gemini CLI** | `.gemini/settings.json` `hooks` key (project + user merged) | `{Event: [{matcher, sequential?, hooks: [{type:"command", command, timeout(ms)}]}]}` | 11 events, **different naming**: BeforeTool, AfterTool, BeforeAgent, AfterAgent, BeforeModel, AfterModel, BeforeToolSelection, SessionStart, SessionEnd, Notification, PreCompress | Enabled by default since v0.26.0; exit 2 = block; timeout in **ms** (default 60000); MCP tools match `mcp_<server>_<tool>` |
| **Copilot** | `.github/hooks/NAME.json` (cloud agent: must be on **default branch**; also read by CLI + VS Code preview) | `{version: 1, hooks: {event: [entry]}}`; entry: `type` (now optional, default `command` — verifier-corrected), `bash`/`powershell` **or** cross-platform `command` (now documented), `cwd`, `env`, `timeoutSec`; new types `http`, `prompt`; top-level `disableAllHooks` | camelCase: sessionStart, sessionEnd, userPromptSubmitted, preToolUse, postToolUse, postToolUseFailure, agentStop, subagentStart/Stop, errorOccurred, preCompact (+ CLI-only: notification, permissionRequest, prompt). **PascalCase Claude-compatible aliases accepted** (switch stdin payload to snake_case) | Cloud agent: `ask` → `deny`; **preToolUse is fail-closed** (timeout/crash = deny); keep hooks <5s; `GITHUB_TOKEN` not set in hook env |

**Cross-provider mapping observations (input for the canonical hook event enum in F1):**
- True all-four common denominator: session-start, pre-tool-use, post-tool-use, stop/session-end, pre-compact(-ish: Gemini calls it PreCompress). `user-prompt-submit` is native on three (Claude UserPromptSubmit, Codex UserPromptSubmit, Copilot userPromptSubmitted) and maps approximately to Gemini's `BeforeAgent` (fires when the agent loop starts processing a prompt). The canonical enum is therefore a mappable superset, not a strict intersection — per-provider gaps surface as `HH-W003`.
- `pre-commit` (in PRD v0.2's example enum) **exists nowhere** — it's a git concept, not an agent-hook event. Drop it from the canonical enum; pre-commit enforcement is I1's job (real git hooks).
- Gemini's Before/After naming and Copilot's camelCase mean the canonical→provider event map is a real translation table, not a copy. Copilot's PascalCase aliases make the Claude-style names a reasonable canonical baseline.
- Unmappable events must trigger the lossy-translation warning (`HH-W003`) per provider, not globally.

---

## The agents.md spec — what canonical may and may not assume

- Spec (now under the Agentic AI Foundation / Linux Foundation, donated 2025-12-09; repo `agentsmd/agents.md`): **"just standard Markdown"** — **no frontmatter, no required sections, no size limits**. Every native consumer injects the file **verbatim**: YAML frontmatter in AGENTS.md would leak as raw text into all providers' prompts. → **Canonical AGENTS.md must be pure markdown.** Scope metadata lives only in `.agents/instructions/*.md` (which no tool reads natively).
- Spec says nearest-wins for nested files; **the two biggest implementations merge instead** (Codex concatenates root→cwd; Copilot combines root+nested). A projector cannot assume either semantics exclusively — document both, emit conservatively.
- Codex caps the combined chain at 32 KiB — keep root AGENTS.md lean, push detail into per-topic files.

---

## Landscape (selected, June 2026)

- **rulesync** — broadest matrix (rules + skills + hooks + commands + subagents + MCC/permissions per tool), but hooks are per-tool passthrough — no unified event taxonomy. Still emits legacy `.codex/skills/`.
- **ruler** (intellectronica) — concatenation-based distribution; opt-in nested `.ruler/` discovery; zero hooks support.
- **crag** — audit-first (`crag audit` detects stale configs/phantom gates, `--fix`, pre-commit drift gate). Disproves PRD v0.2's "existing tools don't audit" claim as stated.
- **dallay/agentsync**, **yelmuratoff/agent_sync** — `status --json`/doctor drift checks; agent_sync has SHA-256 manifests + abort-on-edited-file + an `adopt` reverse-promotion command.
- **`c2c` does not exist** (no npm/GitHub artifact findable) — remove from PRD §2.
- **Defensible differentiation (narrowed):** (1) SignedSource-style *expected-projection* diffing (recompute + content-diff, not just mtime/hash manifests), (2) cataloged & suppressible lossy-translation warnings, (3) a **unified canonical hook event taxonomy** with per-provider mapping — no existing tool has any of the three.

## Strategic risks (new since PRD v0.2)

1. **Gemini CLI consumer sunset 2026-06-18:** Gemini Code Assist free/Pro/Ultra auth stops serving; enterprise licensees + API-key/Vertex auth continue. Google's successor is **Antigravity CLI** (keeps Agent Skills/Hooks/Subagents, different paths). The A3 adapter targets remain technically valid post-sunset (the OSS CLI continues releasing — v0.45.0 on 2026-06-03), but expect the user base to shift; re-validate A3 against Antigravity before v1 ships and consider Antigravity as the fifth adapter candidate.
2. **Codex hook trust churn:** every harness-haircut re-projection of a Codex hook changes its hash → every teammate gets re-prompted to trust it. The Codex adapter should emit *stable* hook bodies (e.g., a thin `command` pointing at a repo script, so editing the script doesn't change the hook definition).
3. **Copilot hook schema evolution:** `type` became optional, cross-platform `command` appeared, `http`/`prompt` types added — pin emitted schema to the conservative subset (`{type:"command", bash, powershell}`) which works everywhere.
4. **VS Code reads Claude-format config** (`.claude/settings.json` hooks, `.claude/rules/` with `paths:`, `CLAUDE.md` via `chat.useClaudeMdFile`) — emitted Claude config has a second consumer; avoid Claude-only assumptions in emitted content.

## Corrections applied to PRD v0.2 (summary)

| PRD v0.2 said | Verified reality |
|---|---|
| Copilot skills: "no native equivalent — warning" | Native Agent Skills since 2025-12-18, reads `.agents/skills/` → **no-op** |
| Copilot hooks: ".github/hooks/*.json (coding agent only)" | Path right; also CLI + VS Code (preview); schema `version:1` + camelCase events + PascalCase aliases |
| Copilot instructions: "root + path-scoped via .github/instructions/" | Plus native AGENTS.md (root+nested) for coding agent/CLI/VS Code; code review still needs the legacy files |
| Codex skills: "via .codex/skills/" | Current docs: `.agents/skills` discovery → **no-op**; `.codex/skills` legacy |
| Codex hooks: "via .codex/config.toml" | Real since GA 2026-05-14; idiomatic target is `.codex/hooks.json`; trust gates apply |
| Claude: "CLAUDE.md shim until #6235 lands" | #6235 still open; blessed shim = one-line `@AGENTS.md` import; `.claude/rules/*.md` + `paths:` for scoped |
| Gemini: "`context.fileName` setting" | Confirmed (nested v2 key, array-capable; replaces default); hooks shipped (v0.26.0+, different event names); `.agents/skills/` alias → skills **no-op** |
| Canonical AGENTS.md frontmatter (`scope:`) | **Invalid** — spec is pure markdown; frontmatter leaks into prompts verbatim |
| Canonical hook enum includes `pre-commit` | No provider has it; drop (git tooling, not agent hooks) |
| §2: rivals don't audit / no 3-layer coverage / "c2c" | crag audits; rulesync covers 3 layers shallowly; c2c doesn't exist — claims narrowed |

---

## AI-assist credential sources — CLI headless modes & subscription sessions

**Researched 2026-06-11** (for story C4 / PRD §17). Feature context: `init --assist` discovers which AI credential sources are available and **proposes** them to the user (no assumed default). A "subscription session" means reusing a provider CLI's already-authenticated login to make one headless completion call — **no separate API key**.

| Provider | Binary | Headless one-shot | Structured output | Subscription session w/o API key? | Paid-call-free auth detection | Env API key | Feasibility |
|---|---|---|---|---|---|---|---|
| Claude Code | `claude` | `claude -p "…"` (`--print`, GA) | `--output-format json` / `--json-schema` | ✅ default for Pro/Max; **`--bare` needs `ANTHROPIC_API_KEY`** | macOS Keychain "Claude Code-credentials"; Linux `~/.claude/.credentials.json` | `ANTHROPIC_API_KEY` (overrides subscription); `CLAUDE_CODE_OAUTH_TOKEN` for CI | **GREEN** |
| OpenAI Codex | `codex` | `codex exec "…"` (`e`) — final msg to stdout | `--json` / `--output-schema` | ✅ ChatGPT Plus/Pro/etc. | **`codex login status` → exit 0 = logged in** (cleanest contract); `~/.codex/auth.json` | `OPENAI_API_KEY` (stateful precedence; see caveat) | **YELLOW** |
| Gemini CLI | `gemini` | `gemini -p "…"` (`--prompt`) | `--output-format json` | ✅ Google AI Pro/Ultra OAuth | `~/.gemini/oauth_creds.json` (caching flaky in headless/cross-dir) | `GEMINI_API_KEY`; Vertex: `GOOGLE_API_KEY`/`GOOGLE_APPLICATION_CREDENTIALS` | **YELLOW** |
| GitHub Copilot | `copilot` | `copilot -p "…"` (`-s` silent, GA 2026-02-25) | **none (text only)** | ✅ Copilot seat (GitHub token, not a model key) | keychain `copilot-cli` / `~/.copilot/config.json`; `/user` interactive | `COPILOT_GITHUB_TOKEN`→`GH_TOKEN`→`GITHUB_TOKEN`; `COPILOT_MODEL` | **YELLOW** |

Model override per call: `--model` / `-m` (Copilot: `--model` or `COPILOT_MODEL`); else the CLI's configured default.

**Feasibility notes & ToS caveats (must be surfaced to the user at selection time):**
- **Claude — GREEN, sanctioned.** From **2026-06-15** Anthropic provisions a *separate monthly Agent SDK credit* for exactly this scripted `claude -p` subscription use — programmatic single calls are blessed, not merely tolerated. Plain `claude -p` uses the subscription; `--bare` skips OAuth/keychain so it needs an API key.
- **Codex — YELLOW.** Works on the ChatGPT session, but OpenAI *recommends API keys for programmatic/CI* use; env-vs-session precedence is stateful in `auth.json` (re-`codex login --with-api-key` to switch — issues #2638/#2733/#3286); calls meter against agentic usage limits.
- **Gemini — YELLOW.** OAuth subscription works headless, but caching is flaky cross-dir/headless, Google steers CI toward service accounts, and consumer-subscription automated-use limits are not clearly documented. (Also note the 2026-06-18 consumer-auth sunset above.)
- **Copilot — YELLOW.** GA headless built for scripting on the existing Copilot subscription (no model key), but **no JSON output** (text-only `-s`) and every call consumes a premium request / AI credit (402 over quota).

**Discovery ranking (for proposal ordering, not auto-selection):** per provider — explicit env **API key** (deterministic, CI-safe, billed-as-expected) ranks above an **authed subscription session** (ToS/metering caveats) above nothing. Discovery probes (a) binary on PATH, (b) env key, (c) authed-session file/keychain presence (prefer a status subcommand where one exists — only Codex has a clean exit-code contract). The user is shown every available source **with its caveat** and **chooses**; nothing is assumed.

Sources: code.claude.com/docs/en/headless + /authentication + support.claude.com article 15036540 (Agent SDK credit, eff. 2026-06-15); developers.openai.com/codex/noninteractive + /auth + help.openai.com 11369540; github.com/google-gemini/gemini-cli docs/cli/headless.md + get-started/authentication.mdx; docs.github.com Copilot CLI programmatic reference + github.blog GA changelog 2026-02-25. All checked 2026-06-11.
