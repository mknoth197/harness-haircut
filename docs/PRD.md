# harness-haircut — Product Requirements Document

**Status:** Draft v0.2
**Owner:** TBD
**Last updated:** 2026-05-08

> **Audit log (2026-05-08):** v0.1 was missing §6–14. This revision fills those sections with reasonable defaults derived from the existing goals and §5 scope table. Defaults are marked **[draft default — open to revision]** so they're easy to spot. No goal in §3 was changed; §15–16 are unchanged.

---

## 1. Overview

`harness-haircut` is a CLI tool that audits a single repository and consolidates redundant AI-provider configuration files into a single canonical source of truth, then projects that source into each provider's native format. It is distributed via `npx` initially, with `uvx` planned. The MVP targets four providers — GitHub Copilot, Claude Code, OpenAI Codex, and Google Gemini CLI — and three configuration layers: instructions, skills, and hooks.

The tool is opinionated about what canonical looks like (`AGENTS.md` at the root and any nested directory; `.agents/` for skills and hooks), pragmatic about where providers diverge (Copilot's flat `.github/instructions/` model, Claude's missing AGENTS.md support), and explicit about lossy translations (it warns rather than silently degrades).

## 2. Problem

Every AI coding provider ships its own configuration file format. A team using more than one provider ends up maintaining redundant copies — `AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md` — that say nearly the same thing but drift apart over time. Drift produces three concrete pains:

- **Contradiction.** Build commands, test invocations, or quality gates get updated in one file and not the others. The provider that reads the stale file generates broken or non-conforming code, and nobody notices until CI fails.
- **Toil.** Every change to project conventions requires updating 4+ files manually. Teams either skip providers (creating coverage gaps) or copy-paste sloppily (creating drift).
- **Cognitive overhead.** New contributors face a wall of near-duplicate config files and no clear answer to "which one is authoritative."

Existing tools in the space (`rulesync`, `ruler`, `crag`, `c2c`) either target too many providers shallowly, focus on rule distribution rather than audit-and-transform, or impose their own intermediate-representation file the user has to learn. None solve nested-and-path-scoped configurations well, and none address all three layers (instructions, skills, hooks) coherently.

## 3. Goals & non-goals

### Goals

1. **Eliminate redundancy.** A team using all four supported providers should maintain content in exactly one place per logical scope.
2. **Detect drift.** A read-only `audit` command surfaces any divergence between source-of-truth files and emitted provider files, and any contradictions between existing config files during initial onboarding.
3. **Be honest about lossy translations.** When a configuration cannot round-trip cleanly (e.g., a non-prefix glob to a tree-walking provider), warn loudly and explicitly rather than silently degrading.
4. **Be safe to re-run.** Every emitted file carries a `@generated SignedSource` header. Re-running detects user edits and prompts before overwriting. `apply` refuses to run with a dirty git tree by default.
5. **Zero AI-provider runtime dependencies.** The tool runs without Claude Code, Codex CLI, Gemini CLI, or any provider tool installed.

### Non-goals (v1)

- **Not** a rule-distribution platform (`instruct-sync`'s territory).
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

| Provider | Instructions | Skills | Hooks |
|---|---|---|---|
| GitHub Copilot | ✅ root + path-scoped via `.github/instructions/` | ❌ no native equivalent — surfaced as warning | ✅ via `.github/hooks/*.json` (coding agent only) |
| Claude Code | ✅ via `CLAUDE.md` shim until anthropics/claude-code#6235 lands | ✅ via `.claude/skills/` | ✅ via `.claude/settings.json` |
| OpenAI Codex | ✅ native `AGENTS.md` (root + nested) | ✅ via `.codex/skills/` | ✅ via `.codex/config.toml` |
| Gemini CLI | ✅ via `GEMINI.md` shim or `context.fileName` setting | ✅ via `.gemini/skills/` | ✅ via `.gemini/settings.json` |

> **Note on `claude-code#6235`:** that issue tracks first-class `AGENTS.md` support in Claude Code. Until it ships, the Claude adapter emits a `CLAUDE.md` projection. When it lands, the adapter switches to a no-op for instructions (Claude reads `AGENTS.md` directly).

### Out of scope (v1)

See §3 non-goals. Concretely the v1 release will not ship: Cursor / Windsurf / Aider / Cline / Continue adapters, multi-repo orchestration, an authoring GUI, hook execution, remote/org-level rule sources, IDE extensions, or migration commands.

---

## 6. Implementation language & runtime *(new)*

**[draft default — open to revision]**

- **v1 implementation:** Node.js 20+ in TypeScript, distributed via npm and runnable through `npx harness-haircut`.
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

- Plain markdown. Optional YAML frontmatter:
  ```yaml
  ---
  scope: "src/api/**"   # optional path glob; absent = applies to this dir + descendants
  ---
  ```
- Root `AGENTS.md` and nested `<dir>/AGENTS.md` are both valid. Nested files apply to that subtree.
- Path-scoped variants (Copilot's `.github/instructions/*.instructions.md` model) are expressed as nested `AGENTS.md` or as additional files under `.agents/instructions/<name>.md` with a `scope` glob in frontmatter.

### Skills: `.agents/skills/<name>/SKILL.md`

- One folder per skill. `SKILL.md` is the entrypoint, with frontmatter:
  ```yaml
  ---
  name: <name>
  description: <one-line trigger description>
  ---
  ```
- Supporting files (e.g., scripts, templates) live alongside `SKILL.md` in the same folder.

### Hooks: `.agents/hooks/<event>.<name>.{sh,js,toml,json}`

- Filename convention: `<event>.<name>.<ext>`, where `<event>` is one of a fixed enum (`pre-tool-use`, `post-tool-use`, `pre-commit`, `session-start`, …; full list in the adapter spec).
- The file body is the executable hook content. `harness-haircut` does not run hooks; it only projects them into provider-specific configs.
- A sibling `.agents/hooks/<event>.<name>.toml` may declare matchers / metadata.

### Config: `harness-haircut.config.json` (optional)

```json
{
  "providers": ["copilot", "claude", "codex", "gemini"],
  "providers_disabled": [],
  "warningsAsErrors": false,
  "writeGitignore": true
}
```

## 9. SignedSource header *(new)*

**[draft default — open to revision]**

Every file `harness-haircut` emits begins with one of:

```
<!-- @generated SignedSource<<<HASH>>> harness-haircut DO NOT EDIT -->
```

(or the language-appropriate comment syntax for non-markdown emitted files).

- **`HASH`** = lowercase hex of `SHA-256(content_after_header_line + "\n" + sources_manifest)`, truncated to 16 chars.
- **`sources_manifest`** = newline-separated list of `<canonical_path>:<sha256_of_content>` for every canonical file that contributed to this projection. Lets `audit` detect both downstream edits *and* upstream changes.
- On `apply`: recompute hash from canonical sources; if disk file hash mismatch but file content unchanged from last emit, overwrite freely. If content was edited (signature line invalid), prompt before overwriting.
- On `audit`: read disk file, recompute expected projection, compare. Mismatch = drift.

## 10. Provider mapping & merge policy *(new)*

**[draft default — open to revision]**

For files that `harness-haircut` co-owns with non-hook configuration (e.g., `.claude/settings.json` already contains user theme settings), the policy is **shallow-merge with key namespacing**:

- The tool reads the existing file, **only** rewrites keys it owns (e.g., `hooks` for Claude, `[hooks]` for Codex), and preserves all other top-level keys.
- A `# managed by harness-haircut: hooks` comment (where the format permits) marks owned regions.
- For files the tool fully owns (e.g., `.github/copilot-instructions.md`), the SignedSource header is the whole file's first line and the tool refuses to merge — it overwrites.

Per-provider details:

| Provider | Owned files | Co-owned files | Merge strategy |
|---|---|---|---|
| Copilot | `.github/copilot-instructions.md`, `.github/instructions/*.instructions.md`, `.github/hooks/*.json` | none | overwrite owned; never touch others |
| Claude | `CLAUDE.md`, `.claude/skills/*` | `.claude/settings.json` | rewrite `hooks` key only |
| Codex | none (writes native `AGENTS.md` already canonical) + `.codex/skills/*` | `.codex/config.toml` | rewrite `[hooks]` table only |
| Gemini | `GEMINI.md`, `.gemini/skills/*` | `.gemini/settings.json` | rewrite `hooks` key only |

## 11. Lossy translation policy *(new)*

**[draft default — open to revision]**

A translation is **lossy** if any of:

- A path glob in canonical can't be expressed in the target provider's matcher language (e.g., regex → glob, brace expansion → no brace expansion).
- A skill exists for a provider that has no skills concept (Copilot).
- A hook event in canonical maps to multiple events in the target (or none).
- Frontmatter metadata (description, activation mode) has no target slot.

On lossy translation:
1. **Warn**: emit a `WARN` line to stderr with the canonical path, target provider, and the specific reason.
2. **Continue**: emit the closest non-lossy approximation, prefixed with a comment in the generated file naming the loss.
3. **`audit` exit code 2** if any warnings fired (between drift's `1` and config-error's `3`).
4. **`--strict`** flag (on any command) escalates warnings to errors.

Warnings are catalogued in `src/warnings/<code>.md` with a stable code (e.g., `HH-W001`) so users can suppress specific warnings via `harness-haircut.config.json`.

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
- **Adapter interface**:
  ```ts
  interface ProviderAdapter {
    id: 'copilot' | 'claude' | 'codex' | 'gemini';
    project(ir: IR, ctx: ProjectionContext): EmittedFile[];
    detectExisting(repo: RepoSnapshot): ExistingProviderConfig | null;
  }
  ```
- **Emitter** writes `EmittedFile[]` with SignedSource headers, respecting merge policy and the dirty-tree guard.

## 13. CI integration *(new)*

**[draft default — open to revision]**

Two artifacts ship with v1:

1. **`harness-haircut install-precommit`** — installs a `.husky/pre-commit` (or plain `.git/hooks/pre-commit`) shim that runs `npx harness-haircut audit --json` and blocks the commit on non-zero.
2. **`templates/github-action.yml`** — a documented snippet users can paste into `.github/workflows/`. The action runs `npx harness-haircut audit` and fails the check on drift.

Both artifacts are documentation + simple scripts in v1; no GitHub App, no marketplace listing.

## 14. Risks & open questions *(new)*

**Risks:**
- **Provider format churn.** Providers ship breaking changes (Claude's `AGENTS.md` support, settings.json schema). Mitigation: adapters are versioned; CI runs daily fixture tests against pinned provider docs.
- **Lossy translation backlash.** Users may be unhappy with WARN noise. Mitigation: per-warning suppression; `--strict` opt-in.
- **SignedSource hash collisions.** 16-char truncation gives 64 bits of collision space — fine for inadvertent edits, weak against adversaries. Acceptable for v1 (no security claim is being made).

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
