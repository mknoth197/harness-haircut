@AGENTS.md

<!-- @hand-emitted-projection
One-line import shim — the officially blessed bridge while Claude Code
lacks native AGENTS.md support (anthropics/claude-code#6235; docs:
"Claude Code reads CLAUDE.md, not AGENTS.md"). The @AGENTS.md import
above loads the canonical standards in full at launch, so this file can
never drift from them. Verified in docs/research/provider-matrix.md.
When `harness-haircut apply` ships (#12) it will own this file; until
then, edits land in AGENTS.md or .agents/instructions/<topic>.md —
never here.
-->

Claude-specific notes (content below the import line is preserved by the future `apply`):

- Per-topic standards live in `.agents/instructions/` — architecture (`src/**/*.ts`), testing (`test/**/*.ts`), commit style (repo-wide). AGENTS.md links them all.
- Product context: `docs/PRD.md` and `docs/stories/` (one EARS story per GitHub issue).
