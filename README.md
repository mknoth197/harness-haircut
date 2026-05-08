# harness-haircut

Audit and consolidate redundant AI-provider configuration files (`AGENTS.md`, `CLAUDE.md`, `GEMINI.md`, `.github/copilot-instructions.md`, …) into a single canonical source of truth, then project that source into each provider's native format.

> **Status:** pre-alpha. The CLI scaffold is in place; commands are stubs. See [`docs/PRD.md`](docs/PRD.md) for the v1 product requirements and [`docs/stories/`](docs/stories/) for the EARS user stories that will fill it in.

## Quick start (once published)

```sh
npx harness-haircut init      # bootstrap canonical layout
npx harness-haircut apply     # project canonical sources to each provider
npx harness-haircut audit     # CI-friendly drift check
```

## Local development

Requires Node.js 20 or later.

```sh
npm install
npm run build      # tsc + shebang fixup
npm test           # node --test against the built CLI
npm run lint       # tsc --noEmit (ESLint will be added in a follow-up story)
```

The compiled CLI lives at `dist/cli.js`. You can run it directly during development:

```sh
node dist/cli.js --version
node dist/cli.js --help
node dist/cli.js audit       # exits 70 (not yet implemented)
```

## Project layout

```
src/             TypeScript sources
  cli.ts         CLI entry, arg parser, dispatch
  index.ts       Library exports
test/            Tests (node --test, plain ESM)
scripts/         Build + repo helper scripts
docs/
  PRD.md         Product requirements (v0.2 — see audit log at top)
  stories/       EARS user stories, one per planned issue
```

## Contributing

Pick a story from [`docs/stories/`](docs/stories/) — they're ordered and the dependency chain is documented in [`docs/stories/README.md`](docs/stories/README.md). The first foundational story (F0) is implemented; F1, F2, and F3 are the next unblocked work items.

## License

MIT — see [`LICENSE`](LICENSE).
