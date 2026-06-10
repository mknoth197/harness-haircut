@AGENTS.md

<!-- @hand-emitted-projection
One-line import shim. Gemini CLI supports @path imports in context files
(maxDepth 5), so the line above loads the canonical AGENTS.md in full and
this file can never drift from it. The cleaner long-term projection is
`context.fileName: ["AGENTS.md", "GEMINI.md"]` in .gemini/settings.json —
that switch lands with the Gemini adapter (A3, issue #9). Verified in
docs/research/provider-matrix.md. When `harness-haircut apply` ships
(#12) it will own this file; until then, edits land in AGENTS.md or
.agents/instructions/<topic>.md — never here.
-->
