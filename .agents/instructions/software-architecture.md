---
scope: "src/**/*.ts"
---

# Software architecture — CLEAN layers

This project follows Clean / Hexagonal architecture. There are exactly **four layers**, and **dependencies point inward**. Outer layers depend on inner layers; the reverse is forbidden.

## Layers (innermost → outermost)

### Layer 1 — Entities (`src/entities/`)

The intermediate representation (IR) of canonical configuration. Pure data and pure business rules.

- **MUST NOT** import from `use-cases/`, `adapters/`, `gateways/`, `cli.ts`, or `bin.ts`.
- **MUST NOT** import any npm package (no Zod, no fast-json-stringify, etc.). Standard library types only.
- **MUST NOT** call global APIs that produce nondeterminism: `Date.now()`, `crypto.randomUUID()`, `Math.random()`, `process.env`. Pass these in as parameters.
- **MAY** export types, interfaces, branded types, and pure functions over those types (validators, comparators, transformers).

The landed shape (F1 [#4](https://github.com/mknoth197/harness-haircut/issues/4)) lives in [`src/entities/ir.ts`](../../src/entities/ir.ts): `Instruction`, `Skill`, `Hook`, `Attachment`, and `IR` (which carries `attachments` alongside the three surfaces), plus the canonical nine-event `HookEvent` enum. That file is the source of truth — this document deliberately does not duplicate it.

### Layer 2 — Use cases (`src/use-cases/`)

Application orchestration: `audit`, `apply`, `init`, `doctor`. One file per use case.

- **MUST NOT** import from `adapters/`, `gateways/`, `cli.ts`, or `bin.ts`.
- **MAY** import from `entities/`.
- **MUST** receive gateway/adapter implementations via parameters (dependency injection from Layer 4). Define gateway interfaces *here*, not in gateways/.
- **MUST** return a result; **MUST NOT** call `process.exit` or write to `process.stderr`/`stdout` directly.

```ts
// src/use-cases/audit.ts
import type { IR } from '../entities/ir.js';
export interface AuditDeps { readRepo: () => Promise<IR>; readDisk: () => Promise<EmittedFile[]>; }
export async function audit(deps: AuditDeps): Promise<AuditReport> { /* … */ }
```

### Layer 3 — Adapters / Gateways (`src/adapters/`, `src/gateways/`)

Concrete implementations of Layer 2's interfaces. Where the outside world meets us.

- **MUST NOT** import from `cli.ts` or `bin.ts`.
- **MAY** import from `entities/` and from interfaces declared in `use-cases/`.
- **MAY** import npm packages and standard library I/O (`node:fs`, `node:child_process`, `node:path`).
- One adapter per AI provider (`src/adapters/codex.ts`, `claude.ts`, `gemini.ts`, `copilot.ts`) — each implements the `ProviderAdapter` interface from `entities/` (lands with F3 [#6](https://github.com/mknoth197/harness-haircut/issues/6)).
- One gateway per external concern (`src/gateways/filesystem.ts`, `src/gateways/git.ts`).

### Layer 4 — Composition root (`src/cli.ts`, `src/bin.ts`)

Wires everything together. Translates argv → use-case calls → exit code.

- **MAY** import from any layer.
- **MUST NOT** contain business logic. If you find yourself writing logic here, move it to a use case.
- The CLI parser, help text, and exit-code routing live in `cli.ts`. The bin shim (`bin.ts`) is one file: import `run`, call it, exit with its code.

## The dependency rule

```
       cli.ts / bin.ts  (Layer 4)
              ↓
        adapters / gateways  (Layer 3)
              ↓
            use-cases  (Layer 2)
              ↓
            entities  (Layer 1)
```

A file at layer N may import from layers 1..N-1. It may NOT import from layers N+1..4. This is currently enforced by code review; once entities + use-cases exist (post-F1), we add a `.dependency-cruiser.cjs` rule to enforce it at lint time.

## Naming & file layout

- One concept per file. Filename matches the primary export (kebab-case): `audit-report.ts` exports `AuditReport`.
- Tests mirror source layout: `src/use-cases/audit.ts` ↔ `test/use-cases/audit.test.ts`.
- Public types from a layer go in an index re-export: `src/entities/index.ts`.

## Error handling

- Define domain errors in `entities/errors.ts` as discriminated unions or typed classes.
- Gateways convert OS/network errors to domain errors before they cross the layer boundary.
- Use cases return errors as part of the result type or throw domain errors; **never** throw raw `Error` from a use case.
- The composition root translates domain errors to exit codes per [PRD §7](../../docs/PRD.md).

## When to add a new layer-3 module vs. extend an existing one

- Adding **a new AI provider** = new adapter file in `src/adapters/`. Same `ProviderAdapter` interface.
- Adding **a new external concern** (a new RPC, a new file format we read) = new file in `src/gateways/`.
- Refactoring across layers = open an issue first. The layer boundaries are the project's most important invariant.
