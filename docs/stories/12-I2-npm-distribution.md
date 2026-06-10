# I2 — npm packaging and `npx` distribution

**Type:** Integration / Release
**Depends on:** F0, F1, F2, F3, A1, A2, A3, A4, C1, C2, C3, I1
**Blocks:** v1.0 release
**Labels:** `enhancement`, `release`

## Context
[PRD §6](../PRD.md) and §16 require `npx harness-haircut` to work for the typical multi-tool repo within 5 minutes. This story is the release-readiness gate: package bundling, README polish, CHANGELOG, semver, and npm publish workflow.

## Requirements (EARS)

- **U1.** The published package shall include only `dist/`, `templates/`, `README.md`, `LICENSE`, and `package.json` (`files` field in package.json explicitly listed).
- **U2.** The CLI shall be runnable via `npx harness-haircut <command>` against a freshly published version.
- **U3.** A GitHub Actions release workflow shall publish to npm on a tagged release.
- **EV1.** When the workflow runs on a tag matching `v*.*.*`, it shall run `npm test`, `npm run build`, then `npm publish --provenance`.
- **OPT1.** Where the tag is a pre-release (`v*.*.*-rc.*`), the workflow shall publish with the `next` dist-tag.
- **UN1.** If `npm test` or `npm run build` fails on the tag, then the workflow shall not publish.

## Acceptance criteria

- [ ] `package.json` `files` field set; `npm pack --dry-run` shows only intended files.
- [ ] `.github/workflows/release.yml` performs the gated publish.
- [ ] README includes a Quick Start: `npx harness-haircut init`, `apply`, `audit`.
- [ ] CHANGELOG.md exists with a v0.1.0 entry.
- [ ] Smoke test: `npm pack && npx -p ./<tarball> harness-haircut --version` works in a clean directory.

## Out of scope
- `uvx` / Python distribution (PRD §15 future scope).
