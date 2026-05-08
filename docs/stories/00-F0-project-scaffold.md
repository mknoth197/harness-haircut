# F0 — Project scaffold and CLI entry point

**Type:** Foundational
**Depends on:** none
**Blocks:** F1, F2, F3 (and transitively, every other story)
**Labels:** `enhancement`, `foundation`

## Context
Per [PRD §6](../PRD.md), v1 ships as a Node.js 24+ TypeScript package distributed via npm/npx. Nothing exists yet — this story stands up the package, build, lint, test, and CLI entry-point so every subsequent story has a place to land code.

## Requirements (EARS)

- **U1.** The package shall be a TypeScript ESM project targeting Node.js 24 or later.
- **U2.** The package shall expose a single CLI binary `harness-haircut` whose entry script lives at `dist/bin.js`. The bin entry shall be a thin shim that calls into a pure `cli` module (so library consumers can `import { run }` without side-effects).
- **U3.** The CLI shall accept the global flags listed in [PRD §7](../PRD.md) (`--cwd`, `--config`, `--json`, `--no-color`, `--verbose`, `--help`, `--version`).
- **U4.** The CLI shall recognize the four v1 subcommand names (`init`, `audit`, `apply`, `doctor`) and dispatch to a registered handler.
- **EV1.** When invoked with `--version`, the CLI shall print the package version from `package.json` and exit 0.
- **EV2.** When invoked with `--help` (or no command), the CLI shall print the command list and exit 0.
- **UN1.** If the CLI is invoked with an unknown subcommand, then it shall print an error to stderr and exit with code 64.
- **UN2.** If a required handler is not yet implemented, then the CLI shall print `not yet implemented` to stderr and exit with code 70.

## Acceptance criteria

- [x] `package.json` declares `"type": "module"`, `"bin": { "harness-haircut": "dist/bin.js" }`, and `engines.node >= 20`.
- [x] `tsconfig.json` configured for ESM, strict mode, `outDir: dist`.
- [x] `npm run build` produces `dist/bin.js` with a shebang.
- [x] `npm test` runs and passes a smoke test that spawns the built binary and asserts on `--version` output.
- [x] `npm run lint` runs ESLint and passes on the scaffold; `npm run typecheck` runs `tsc --noEmit`.
- [x] `npx harness-haircut audit` (post-build) prints `not yet implemented` and exits 70.
- [x] `.gitignore` excludes `node_modules/`, `dist/`, and `*.tgz`.

## Out of scope
- Actual command logic (covered by C1, C2, C3).
- Publishing to npm (covered by I2).
