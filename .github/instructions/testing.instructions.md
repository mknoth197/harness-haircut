---
applyTo: "test/**/*.ts"
---

<!-- @hand-emitted-projection
Projection of .agents/instructions/testing.md for GitHub Copilot.
Edits should land in the canonical file first. Once `harness-haircut apply`
ships (C2 #12), this projection is regenerated automatically.
-->

# Testing conventions

`node --test` with native TypeScript type-stripping (Node 24+). **No** Jest, Vitest, Mocha, or other runner. **No** test-double libraries — hand-roll fakes.

## Three test categories

1. **Unit** — one source file under test, no I/O, no spawning. Stub dependencies by passing fakes.
2. **Integration** — exercise a use case end-to-end against a real filesystem in `os.tmpdir()`. Per-test setup + teardown. No AI-provider runtimes.
3. **End-to-end** — `spawnSync(process.execPath, [binPath, ...])` against the built `dist/bin.js`. Assert on exit code, stdout, stderr.

## File layout

- All test files: `test/**/*.test.ts`.
- Mirror source layout: `src/use-cases/audit.ts` → `test/use-cases/audit.test.ts`.
- Top-level `test/cli.test.ts` allowed for cross-cutting concerns.
- Shared helpers go in `test/_helpers/*.ts`.

## Test structure

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('audit()', () => {
  it('exits 0 when canonical matches disk', async () => { /* … */ });
});
```

Prefer `assert/strict` matchers (`assert.equal`, `assert.deepEqual`, `assert.match`).

## What to test

- **Every EARS rule** in the corresponding user story.
- **Every exit code** from [PRD §7](../../docs/PRD.md).
- **Every lossy warning code** (`HH-Wxxx`) and its downgraded output.
- **Idempotency**: `apply → apply → no changes` for mutating use cases.

## Naming

- Test names read as sentences: `it('rejects --cwd with no value', ...)`. No `should`, no `test_` prefix.

## Coverage

No formal gate in v0.x. Aim:
- **Entities**: 100% line + branch.
- **Use cases**: every public path.
- **Adapters**: every translation case + every warning code.
- **Composition root**: smoke only.

See [`.agents/instructions/testing.md`](../../.agents/instructions/testing.md) for the canonical full version with running commands and fixtures policy.
