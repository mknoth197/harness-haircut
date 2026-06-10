---
scope: "test/**/*.ts"
---

# Testing conventions

`node --test` with native TypeScript type-stripping (Node 24+). **No** Jest, Vitest, Mocha, or other runner. **No** test-double libraries (sinon, jest-mock) — hand-roll fakes where needed.

## Three test categories

1. **Unit tests** — one source file per test, no I/O, no spawning. Test the pure logic of a single layer. Stub dependencies by passing fakes that implement the same interface.
2. **Integration tests** — exercise a use case end-to-end against a real filesystem in `os.tmpdir()`. Set up + tear down per-test. No AI-provider runtimes (the PRD non-goal: zero AI-provider deps).
3. **End-to-end (E2E)** — `spawnSync(process.execPath, [binPath, ...])` against the built `dist/bin.js`; assert on exit code, stdout, stderr. These exist to validate the **whole** pipeline (parser → run → bin shim → exit code).

## File layout

- All test files: `test/**/*.test.ts`.
- Mirror source layout: `src/use-cases/audit.ts` → `test/use-cases/audit.test.ts`.
- Top-level `test/cli.test.ts` is allowed for cross-cutting concerns (the F0 CLI smoke tests live here).
- Shared helpers (e.g., a `mkTempRepo()` utility) go in `test/_helpers/*.ts`.

## Test structure

Use `node:test`'s `describe`/`it` syntax:

```ts
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('audit()', () => {
  it('exits 0 when canonical matches disk', async () => {
    // arrange
    // act
    // assert
  });

  it('exits 1 when an emitted file was hand-edited', async () => {
    // …
  });
});
```

Prefer `assert/strict` (`assert.equal`, `assert.deepEqual`, `assert.match`). Avoid `assert.ok(condition)` when a more specific matcher exists.

## What to test

- **Every EARS rule** in the corresponding user story gets a test. A `U` rule may need several tests covering boundary cases.
- **Exit codes**: every command's exit-code table from [PRD §7](../../docs/PRD.md) gets a test.
- **Lossy translations**: every adapter that can produce a warning has a test asserting both the warning code (`HH-Wxxx`) and the downgraded output.
- **Idempotency**: use cases that mutate disk get an `apply → apply → no changes` test.

## What NOT to test

- Implementation details that aren't observable through the use-case interface.
- Library code (we don't ship one; this is irrelevant until we do).
- Node standard library behavior.

## Naming

- Test names read as sentences: `it('rejects --cwd with no value', ...)`. No `should`, no `test_` prefix.
- One assertion per `it` when reasonable; multiple are fine if they describe a single behavior.

## Coverage

No formal coverage gate in v0.x. Aim for:
- **Entities**: 100% line + branch (they're pure and tiny).
- **Use cases**: every public path covered.
- **Adapters**: every documented translation case + every warning code.
- **Composition root**: smoke-only (the existing F0 CLI tests).

Once F1–F3 land and we have meaningful code, revisit and consider c8 + a CI gate.

## Running tests

```sh
npm test                                # build + run all tests
node --test "test/**/*.test.ts"         # run tests against existing dist/
node --test --test-name-pattern="audit" # filter by name
node --test --test-only test/cli.test.ts # run a single file
```

## Test data

- Prefer realistic fixtures over property-based generation (until F4+ when we add a fuzz step).
- Fixtures live alongside their tests in `test/<area>/fixtures/`.
- Never check in fixtures with absolute paths or hostnames.
