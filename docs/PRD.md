# harness-haircut — Product Requirements Document

**Status:** Draft v0.3
**Owner:** TBD
**Last updated:** 2026-06-10

> **Audit log (2026-05-08):** v0.1 was missing §6–14. This revision fills those sections with reasonable defaults derived from the existing goals and §5 scope table. Defaults are marked **[draft default — open to revision]** so they're easy to spot. No goal in §3 was changed; §15–16 are unchanged.
>
> **Audit log (2026-06-10, v0.3):** provider facts verified against current official documentation via a 10-agent research workflow — see [`docs/research/provider-matrix.md`](research/provider-matrix.md) for the full matrix with citations. Major corrections: `.agents/skills/` is read natively by Codex, Gemini CLI, and Copilot (skills projection becomes a no-op for 3 of 4 providers); Copilot reads AGENTS.md (root+nested) for the coding agent/CLI/VS Code but NOT for code review; all four providers now ship hooks, with divergent event taxonomies; canonical AGENTS.md must be pure markdown (the spec defines no frontmatter and consumers inject the file verbatim); `pre-commit` removed from the canonical hook enum (no provider has it). §9 also revised (two-hash SignedSource header). Affected sections: §2, §5, §8, §9, §10, §14.

---

## 1. Overview

`harness-haircut` is a CLI tool that audits a single repository and consolidates redundant AI-provider configuration files into a single canonical source of truth, then projects that source into each provider's native format. It is distributed via `npx` initially, with `uvx` planned. The MVP targets four providers — GitHub Copilot, Claude Code, OpenAI Codex, and Google Gemini CLI — and three configuration layers: instructions, skills, and hooks.

The tool is opinionated about what canonical looks like (`AGENTS.md` at the root and any nested directory; `.agents/instructions/` for scoped instruction fragments; `.agents/skills/` and `.agents/hooks/` for the other two layers), pragmatic about where providers diverge (Copilot's code-review surface, Claude's missing AGENTS.md support), and explicit about lossy translations (it warns rather than silently degrades).

## 2. Problem

Every AI coding provider ships its own configuration file format. A team using more than one provider ends up maintaining redundant copies — `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md` — that say nearly the same thing but drift apart over time. Drift produces three concrete pains:

- **Contradiction.** Build commands, test invocations, or quality gates get updated in one file and not the others. The provider that reads the stale file generates broken or non-conforming code, and nobody notices until CI fails.
- **Toil.** Every change to project conventions requires updating 4+ files manually. Teams either skip providers (creating coverage gaps) or copy-paste sloppily (creating drift).
- **Cognitive overhead.** New contributors face a wall of near-duplicate config files and no clear answer to "which one is authoritative."

Existing tools in the space (`rulesync`, `ruler`, `crag`, `agentsync`, `agent_sync`) each cover parts of the problem: `crag` audits, `rulesync` distributes rules/skills/hooks per-tool, `agent_sync` has sync manifests. What none of them have — the defensible gap, verified against the June-2026 landscape in [`docs/research/provider-matrix.md`](research/provider-matrix.md) — is (1) **expected-projection diffing** (recompute what *should* be on disk from canonical sources and content-diff it, SignedSource-style, rather than mtime/manifest checks), (2) **cataloged, suppressible lossy-translation warnings**, and (3) a **unified canonical hook event taxonomy** mapped per provider rather than passthrough per-tool hook configs.

## 3. Goals & non-goals

### Goals

1. **Eliminate redundancy.** A team using all four supported providers should maintain content in exactly one place per logical scope.
2. **Detect drift.** A read-only `audit` command surfaces any divergence between source-of-truth files and emitted provider files, and any contradictions between existing config files during initial onboarding.
3. **Be honest about lossy translations.** When a configuration cannot round-trip cleanly (e.g., a non-prefix glob to a tree-walking provider), warn loudly and explicitly rather than silently degrading.
4. **Be safe to re-run.** Every emitted file carries a `@generated SignedSource` header. Re-running detects user edits and prompts before overwriting. `apply` refuses to run with a dirty git tree by default.
5. **Zero AI-provider runtime dependencies.** The tool runs without Claude Code, Codex CLI, Gemini CLI, or any provider tool installed.

### Non-goals (v1)

- **Not** a rule-distribution platform (`rulesync`'s territory).
- **Not** a multi-repo / org-wide governance system. Scope is one repo at a time.
- **Not** an authoring UI. Users edit markdown directly.
- **Not** trying to support every provider. v1 is Copilot, Claude, Codex, Gemini. Cursor, Windsurf, Aider, Cline, Continue, etc. are explicit non-goals for v1 and may be added later as community-contributed adapters.
- **Not** a hook execution engine. The tool *generates* hook configurations; the providers *run* them.

## 4. Users & use cases

**Primary user:** A staff/senior engineer on a multi-tool team who has been hand-syncing AI config files for months and is tired of it. They want to run one command, get a clean canonical setup, and never think about it again until they update a rule.

**Secondary user:** A new contributor to a repo that has already adopted `harness-haircut`. They edit `AGENTS.md` (or a nested one) and run `npx harness-haircut apply` to refresh the projections. The pre-commit hook catches any forgotten regenerations.

**Core use cases:**

1. **Onboarding** — point the tool at an existing repo with 3–4 drifted config files; it merges them interactively into a canonical layout, surfacing contradictions for resolution.
2. **Maintenance** — edit `AGENTS.md`; run `apply`; the tool regenerates only the files that need updating.
3. **CI enforcement** — pre-commit and GitHub Action integrations fail the build if config files are out of sync with their source.
4. **Migration** — adopt a new provider (or drop one); the tool adds/removes the relevant projections without touching authoritative content.

## 5. Scope

### In scope (v1)

*(Table verified 2026-06-10 against official docs — full matrix with citations in [`docs/research/provider-matrix.md`](research/provider-matrix.md).)*

| Provider | Instructions | Skills | Hooks |
|---|---|---|---|
| GitHub Copilot | ✅ native `AGENTS.md` root+nested for coding agent/CLI/VS Code (since 2025-08-28); `.github/copilot-instructions.md` + `.github/instructions/*.instructions.md` (`applyTo` globs) still emitted to cover **code review**, which does not read AGENTS.md | ✅ **no-op** — reads canonical `.agents/skills/` natively (Agent Skills standard, since 2025-12-18) | ✅ via `.github/hooks/*.json` (`version: 1` schema; cloud agent — default branch only — plus CLI and VS Code preview) |
| Claude Code | ✅ via one-line `CLAUDE.md` shim (`@AGENTS.md` import — the officially blessed bridge while anthropics/claude-code#6235 stays open); scoped instructions via `.claude/rules/*.md` with `paths:` globs | ✅ projected to `.claude/skills/` (only provider not reading `.agents/skills/`) | ✅ via `hooks` key in `.claude/settings.json` (~30-event taxonomy) |
| OpenAI Codex | ✅ native `AGENTS.md` (root→cwd concatenation, 32 KiB combined cap) | ✅ **no-op** — current docs discover `.agents/skills` natively (`.codex/skills` is legacy) | ✅ via `.codex/hooks.json` (idiomatic) or `[hooks]` in `.codex/config.toml`; GA 2026-05-14; per-user hash-pinned trust review applies |
| Gemini CLI | ✅ via `context.fileName: ["AGENTS.md", "GEMINI.md"]` in `.gemini/settings.json` (or a `GEMINI.md` `@AGENTS.md` import shim) | ✅ **no-op** — `.agents/skills/` alias takes precedence over `.gemini/skills/` | ✅ via `hooks` key in `.gemini/settings.json` (Before/After event naming; needs event-name mapping) |

> **Note on `claude-code#6235`:** still open as of 2026-06-10 with no maintainer commitment ("Claude Code reads CLAUDE.md, not AGENTS.md" — current docs). The blessed bridge is a `CLAUDE.md` whose first line is the import `@AGENTS.md` — a one-line projection that cannot drift. When/if #6235 lands, the Claude instructions projection becomes a full no-op.
>
> **Skills convergence:** because Codex, Gemini CLI, and Copilot all read `.agents/skills/<name>/SKILL.md` natively, the canonical skills location IS the native location for 3 of 4 providers. All four use the same Agent Skills SKILL.md format (required frontmatter: `name`, `description`); canonical skills must stick to that common core, with provider-specific frontmatter extras treated as lossy.

### Out of scope (v1)

See §3 non-goals. Concretely the v1 release will not ship: Cursor / Windsurf / Aider / Cline / Continue adapters, multi-repo orchestration, an authoring GUI, hook execution, remote/org-level rule sources, IDE extensions, or migration commands.

---

## 6. Implementation language & runtime *(new)*

**[draft default — open to revision]**

- **v1 implementation:** Node.js 24+ in TypeScript, distributed via npm and runnable through `npx harness-haircut`.
- **Rationale:** the `npx` distribution channel is already a stated requirement; the four target providers' configuration files are markdown / JSON / TOML which Node parses ergonomically; and the primary user already has `node` installed (any team using Copilot or Claude Code in the modern toolchain has it).
- **`uvx` distribution (post-v1):** either a Python rewrite or a published wheel that wraps the Node binary. Out of v1 scope.
- **Build target:** ESM, single CLI binary entry, no native dependencies.

## 7. CLI surface *(new)*

**[draft default — open to revision]**

```
harness-haircut <command> [options]

Commands:
  init       Bootstrap canonical layout from an existing repo (interactive merge)
  audit      Read-only drift check; exits non-zero on any divergence or warning
  apply      Project canonical sources into provider-specific files
  doctor     Print configuration, detected providers, and version info

Global options:
  --cwd <path>        Run as if invoked in <path> (default: process.cwd())
  --config <path>     Path to harness-haircut.config.json (default: ./harness-haircut.config.json)
  --json              Emit machine-readable JSON to stdout
  --no-color          Disable colored output
  -v, --verbose       Verbose logging
  -h, --help          Show help
  --version           Show version
```

### Per-command contract

**`init`**
- Scans the repo, detects existing provider configs.
- Surfaces *contradictions* between config files (e.g., one says `pnpm test`, another says `npm test`). Prompts the user for the canonical answer per contradiction.
- Writes canonical `AGENTS.md` and `.agents/` layout.
- Calls `apply` at the end.
- Flags: `--dry-run`, `--non-interactive` (fails on any unresolved contradiction).

**`audit`**
- Read-only. No file writes.
- Exit codes: `0` clean, `1` drift detected, `2` lossy-translation warning, `3` invalid config, `64+` system error.
- `--json` emits a structured report.

**`apply`**
- Refuses to run with a dirty git tree unless `--allow-dirty`.
- For each emitted file: if `@generated SignedSource` hash mismatch (user edited), prompt before overwrite (or fail with `--non-interactive`).
- Flags: `--dry-run`, `--non-interactive`, `--allow-dirty`.
- Idempotent: `apply && audit` always exits 0 on a clean tree.

**`doctor`**
- Prints version, Node version, detected providers in repo, parsed config, and any warnings about the environment.

## 8. Canonical format *(new)*

**[draft default — open to revision]**

### Instructions: `AGENTS.md`

- **Pure markdown — no frontmatter.** The agents.md spec defines none, and every native consumer (Codex, Copilot coding agent, configured Gemini CLI, …) injects the file **verbatim**: YAML frontmatter would leak as raw text into providers' prompts. *(v0.3 correction — v0.2 allowed an optional `scope:` frontmatter block here.)*
- Root `AGENTS.md` and nested `<dir>/AGENTS.md` are both valid. Nested files apply to that subtree. Note the spec/implementation divergence: the spec says nearest-wins, but Codex *concatenates* root→cwd and Copilot *combines* root+nested — emitted content must read correctly under both semantics.
- Keep root `AGENTS.md` lean: Codex caps the combined nested chain at **32 KiB** (`project_doc_max_bytes` default).
- Path-scoped instruction *fragments* live under `.agents/instructions/<name>.md` with a `scope:` glob in frontmatter — that directory is read by no provider natively, so frontmatter is safe there. They project to Copilot `.instructions.md` `applyTo` files and Claude `.claude/rules/*.md` `paths:` files.

### Skills: `.agents/skills/<name>/SKILL.md`

- One folder per skill. `SKILL.md` is the entrypoint, with frontmatter following the Agent Skills open standard **common core**:
  ```yaml
  ---
  name: <lowercase-hyphenated, should match folder name>
  description: <one-line trigger description>
  ---
  ```
- Supporting files (`scripts/`, `references/`, `assets/`) live alongside `SKILL.md` in the same folder.
- **This location is native** for Codex, Gemini CLI, and Copilot (verified 2026-06-10) — no projection emitted for them. Claude Code is the only provider needing a `.claude/skills/` projection.
- Provider-specific frontmatter extras (Claude's `allowed-tools`/`context`/`hooks`, Codex's `agents/openai.yaml`, …) are out of the canonical core; if present they are passed through to providers that understand them and trigger a lossy warning for the rest.

### Hooks: `.agents/hooks/<event>.<name>.{sh,js,toml,json}`

- Filename convention: `<event>.<name>.<ext>`, where `<event>` is one of the **canonical event enum** — a canonical superset chosen for cross-provider mappability (verified against all four providers' current taxonomies; not every provider has every event — gaps trigger `HH-W003` per provider):
  `session-start`, `session-end`, `user-prompt-submit`, `pre-tool-use`, `post-tool-use`, `stop`, `subagent-start`, `subagent-stop`, `pre-compact`.
  *(v0.3 correction: `pre-commit` removed — no provider has an agent-hook event for it; git-level pre-commit enforcement is I1's job.)*
- Canonical events map to provider-native names via per-adapter translation tables (e.g., `pre-tool-use` → Claude `PreToolUse` / Codex `PreToolUse` / Gemini `BeforeTool` / Copilot `preToolUse`). Events a provider lacks trigger `HH-W003` for that provider only.
- The file body is the executable hook content. `harness-haircut` does not run hooks; it only projects them into provider-specific configs.
- A sibling `.agents/hooks/<event>.<name>.toml` may declare matchers / metadata.
- Projection stability matters: Codex requires per-user hash-pinned trust of each hook definition, re-prompted whenever the definition changes — so adapters should emit thin, stable commands (e.g., invoke a repo script) rather than inlining hook bodies that churn.

### Config: `harness-haircut.config.json` (optional)

```json
{
  "providers": ["copilot", "claude", "codex", "gemini"],
  "providers_disabled": [],
  "warningsAsErrors": false,
  "writeGitignore": true,
  "gemini": { "mode": "settings" }
}
```

- `gemini.mode`: `"settings"` (default — write `context.fileName` into `.gemini/settings.json`) or `"shim"` (emit a `GEMINI.md` `@AGENTS.md` import instead). See A3 (#9).

## 9. SignedSource header *(new)*

**[draft default — open to revision]**

> **Revision note (v0.3):** the v0.2 draft used a single combined hash of body + sources. That design cannot distinguish "user edited the emitted file" from "canonical sources changed since emit" — any mismatch is ambiguous — yet the `apply` overwrite policy and story F2 (#5) depend on exactly that distinction. The header therefore carries **two** hashes.

Every file `harness-haircut` emits begins with one of:

```
<!-- @generated SignedSource<<<BODY_HASH.SOURCES_HASH>>> harness-haircut DO NOT EDIT -->
```

(or the language-appropriate comment syntax for non-markdown emitted files).

**Carve-outs — two emitted-file classes carry no SignedSource header:**

1. **One-line import shims** (`CLAUDE.md`, and `GEMINI.md` in shim mode): their first line MUST be `@AGENTS.md` for the provider to resolve the import, and their content never derives from canonical sources (it *references* them), so drift is structurally impossible. Ownership rule instead: the tool owns only the first line; `verify` for shims = "first line is exactly `@AGENTS.md`"; everything below it is user content and is always preserved.
2. **Merge-key targets** (`.claude/settings.json`, `.gemini/settings.json`, `.codex/config.toml`): JSON has no comments and the file is co-owned. Drift detection for these compares the owned key's value against the expected projection (F3 merge policy), not a header.

- **`BODY_HASH`** = lowercase hex of `SHA-256(content_after_header_line)`, truncated to 16 chars. Binds the emitted body.
- **`SOURCES_HASH`** = lowercase hex of `SHA-256(sources_manifest)`, truncated to 16 chars. Binds the canonical inputs.
- **`sources_manifest`** = `<canonical_path>:<sha256_of_content>` lines for every canonical file that contributed to this projection, sorted by path, joined with `\n`.

Verification takes the disk file **and** the current canonical sources, and returns one of four states:

| State | Condition | Meaning |
|---|---|---|
| `unmanaged` | no header present | file is not ours; never overwrite silently |
| `edited` | `BODY_HASH` ≠ hash(disk body) | user modified the generated file — prompt before overwrite (fail under `--non-interactive`) |
| `stale` | body intact, `SOURCES_HASH` ≠ hash(current manifest) | canonical sources changed since emit — safe to overwrite freely |
| `clean` | both hashes match | up to date |

- On `apply`: `clean` → skip; `stale` → overwrite; `edited` → prompt; `unmanaged` at a target path → refuse with error.
- On `audit`: any state other than `clean` for an expected emitted file is reported (`stale`/`edited` → drift, exit 1; `unmanaged` → drift with a distinct message).

## 10. Provider mapping & merge policy *(new)*

**[draft default — open to revision]**

For files that `harness-haircut` co-owns with non-hook configuration (e.g., `.claude/settings.json` already contains user theme settings), the policy is **shallow-merge with key namespacing**:

- The tool reads the existing file, **only** rewrites keys it owns (e.g., `hooks` for Claude, `[hooks]` for Codex), and preserves all other top-level keys.
- A `# managed by harness-haircut: hooks` comment (where the format permits) marks owned regions.
- For files the tool fully owns (e.g., `.github/copilot-instructions.md`), the SignedSource header is the whole file's first line and the tool refuses to merge — it overwrites.

Per-provider details *(v0.3 — verified against current docs; see [`docs/research/provider-matrix.md`](research/provider-matrix.md))*:

| Provider | Owned files | Co-owned files | Merge strategy |
|---|---|---|---|
| Copilot | `.github/copilot-instructions.md`, `.github/instructions/hh.*.instructions.md` (namespaced — user-authored `.instructions.md` files are never touched), `.github/hooks/harness-haircut.json` | none | overwrite owned; never touch other `.github/hooks/*.json` or un-namespaced `.instructions.md` files. Skills: no emission (`.agents/skills/` read natively). Hook entries pinned to the conservative cross-surface schema (`{type:"command", bash, powershell}`) |
| Claude | `CLAUDE.md` at root and one per nested `AGENTS.md` directory (one-line `@AGENTS.md` import shims — content below the import line is user-owned and preserved), `.claude/skills/*` (projection of `.agents/skills/`), `.claude/rules/hh.*.md` (projections of scoped `.agents/instructions/`) | `.claude/settings.json` | rewrite `hooks` key only; preserve all other keys |
| Codex | `.codex/hooks.json` | `.codex/config.toml` (only if user opts into `[hooks]`-in-config style) | prefer owning `.codex/hooks.json` outright; never touch `config.toml` otherwise. Instructions and skills: no emission (native). Emit stable hook bodies (trust-hash churn, see §8) |
| Gemini | `GEMINI.md` (only in shim mode) | `.gemini/settings.json` | rewrite `hooks` key and `context.fileName` key only; preserve all other keys (incl. user `mcpServers`, `tools.*`). Skills: no emission (`.agents/skills/` alias is native and higher-precedence) |

## 11. Lossy translation policy *(new)*

**[draft default — open to revision]**

A translation is **lossy** if any of:

- A path glob in canonical can't be expressed in the target provider's matcher language (e.g., regex → glob, brace expansion → no brace expansion).
- A skill exists for a provider that has no skills concept (none of the v1 four — all consume Agent Skills as of 2026; the rule remains for future adapters) or uses provider-specific frontmatter extras the target cannot represent.
- A hook event in canonical maps to multiple events in the target (or none).
- Frontmatter metadata (description, activation mode) has no target slot.

On lossy translation:
1. **Warn**: emit a `WARN` line to stderr with the canonical path, target provider, and the specific reason.
2. **Continue**: emit the closest non-lossy approximation, prefixed with a comment in the generated file naming the loss.
3. **`audit` exit code 2** if any warnings fired (between drift's `1` and config-error's `3`).
4. **`--strict`** flag (on any command) escalates warnings to errors.

Warning codes are defined in `src/entities/warnings.ts` (the registry F3 specifies), with one explanation page per code under `docs/warnings/HH-Wxxx.md`; users suppress specific codes via `harness-haircut.config.json`.

## 12. Architecture *(new)*

**[draft default — open to revision]**

Pipeline:

```
discover → parse → IR → adapters → emit
                         ↑
              audit reads disk, re-runs the same pipeline,
              and diffs the disk state against the emit step.
```

- **Discovery** walks the repo from `--cwd`, enumerating `AGENTS.md`, `.agents/`, and known provider files.
- **Parser** reads canonical sources into an in-memory IR: `Instruction[]`, `Skill[]`, `Hook[]`.
- **IR** is the single boundary between canonical-format concerns and provider-format concerns. New providers are pure adapters over IR.
- **Adapter interface** (aligned with F3 — `project` returns a `Projection`, not a bare file list, so native no-op surfaces are reportable):
  ```ts
  interface ProviderAdapter {
    id: 'copilot' | 'claude' | 'codex' | 'gemini';
    project(ir: IR, ctx: ProjectionContext): Projection;
    detectExisting(repo: RepoSnapshot): ExistingProviderConfig | null;
  }
  interface Projection {
    files: EmittedFile[];
    warnings: Warning[];
    surfaces: Record<'instructions' | 'skills' | 'hooks', 'emitted' | 'merged' | 'native' | 'skipped'>;
  }
  ```
- **Emitter** writes `Projection.files` with SignedSource headers where applicable (§9 carve-outs), respecting merge policy and the dirty-tree guard.

## 13. CI integration *(new)*

**[draft default — open to revision]**

Two artifacts ship with v1:

1. **`harness-haircut install-precommit`** — installs a `.husky/pre-commit` (or plain `.git/hooks/pre-commit`) shim that runs `npx harness-haircut audit --json` and blocks the commit on non-zero.
2. **`templates/github-action.yml`** — a documented snippet users can paste into `.github/workflows/`. The action runs `npx harness-haircut audit` and fails the check on drift.

Both artifacts are documentation + simple scripts in v1; no GitHub App, no marketplace listing.

## 14. Risks & open questions *(new)*

**Risks:**
- **Provider format churn.** Providers ship breaking changes (Claude's `AGENTS.md` support, settings.json schema). Mitigation: adapters are versioned; CI runs daily fixture tests against pinned provider docs. *Observed in practice during the v0.3 research pass: Copilot's hook schema gained a cross-platform `command` key and `http`/`prompt` types; Codex moved skills discovery from `.codex/skills` to `.agents/skills` within ~6 months.*
- **Gemini CLI consumer sunset (v0.3).** Gemini Code Assist free/Pro/Ultra auth stops serving on **2026-06-18**; enterprise + API-key/Vertex auth continue, and the OSS CLI keeps releasing. Google's successor is **Antigravity CLI** (keeps skills/hooks/subagents, different config paths). Mitigation: A3 ships as specced (targets remain technically valid), but re-validate against Antigravity before v1.0 and treat an Antigravity adapter as the leading v2 candidate.
- **Codex hook trust churn (v0.3).** Codex requires per-user, hash-pinned trust of each hook definition; any re-projection that changes a hook re-prompts every teammate. Mitigation: adapter emits thin stable commands pointing at repo scripts (§8, §10).
- **Lossy translation backlash.** Users may be unhappy with WARN noise. Mitigation: per-warning suppression; `--strict` opt-in.
- **SignedSource hash collisions.** 16-char truncation gives 64 bits of collision space — fine for inadvertent edits, weak against adversaries. Acceptable for v1 (no security claim is being made).
- **Spec-vs-implementation divergence on nested AGENTS.md (v0.3).** The agents.md spec says nearest-wins; Codex concatenates and Copilot combines. Mitigation: emitted nested content must be self-contained enough to read correctly under both semantics; documented in §8.

**Open questions (deferred to product owner):**
- Should `init` support a `--from <provider>` mode that treats one drifted file as authoritative, instead of interactive merge?
- Should the tool ever update `.gitignore` for provider state files (`.claude/projects/`, etc.)? Default in §8 says yes via `writeGitignore: true`; revisit.
- Should `apply` write a manifest (`.agents/.manifest.json`) listing every emitted file for clean-up on provider removal? Leaning yes.

---

## 15. Future scope (v2+, not committed)

- **Add Cursor.** Requires handling `.mdc` activation modes (always / glob / description-match / manual) and round-trip with non-trivial frontmatter.
- **Add Windsurf.** Requires character-cap enforcement (12,000 chars per workspace rules file) and trigger taxonomy translation.
- **Add Aider.** Trivial — `CONVENTIONS.md` is essentially `AGENTS.md` with a different name; no skills or hooks worth speaking of.
- **VS Code / JetBrains extensions** that surface drift inline in the editor.
- **Org-wide source-of-truth repos.** Pull canonical rules from a remote git repo instead of (or in addition to) local `.agents/`.
- **Migration commands.** `harness-haircut migrate-from cursor` to import an existing `.cursor/rules/` setup.

## 16. Success metrics

- A repo using all 4 providers maintains content in **1** logical location (per scope) instead of 4.
- `audit` exits 0 on a clean repo in **<100ms**.
- `apply` is **idempotent**: `apply && audit` exits 0.
- **Zero** silent data loss. Every lossy translation produces a warning the user can act on.
- Onboarding (running `init` for the first time) takes **<5 minutes** for a typical multi-tool repo.

---

*End of PRD.*
