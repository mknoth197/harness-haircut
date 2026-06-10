---
applyTo: "src/**/*.ts"
---

<!-- @hand-emitted-projection
Projection of .agents/instructions/software-architecture.md for GitHub Copilot.
Edits should land in the canonical file first. Once `harness-haircut apply`
ships (C2 #12), this projection is regenerated automatically.
-->

# Software architecture — CLEAN layers

This project follows Clean / Hexagonal architecture. There are exactly **four layers**, and **dependencies point inward**. Outer layers depend on inner layers; the reverse is forbidden.

## Layers (innermost → outermost)

### Layer 1 — Entities (`src/entities/`)

The intermediate representation (IR) of canonical configuration. Pure data and pure business rules.

- **MUST NOT** import from `use-cases/`, `adapters/`, `gateways/`, `cli.ts`, or `bin.ts`.
- **MUST NOT** import any npm package. Standard library types only.
- **MUST NOT** call global APIs that produce nondeterminism: `Date.now()`, `crypto.randomUUID()`, `Math.random()`, `process.env`. Pass these in as parameters.
- **MAY** export types, interfaces, branded types, and pure functions over those types.

The landed IR shape (F1 #4) lives in `src/entities/ir.ts` (`Instruction`, `Skill`, `Hook`, `Attachment`, `IR`, and the canonical nine-event `HookEvent` enum) — that file is the source of truth.

### Layer 2 — Use cases (`src/use-cases/`)

Application orchestration: `audit`, `apply`, `init`, `doctor`.

- **MUST NOT** import from `adapters/`, `gateways/`, `cli.ts`, or `bin.ts`.
- **MAY** import from `entities/`.
- **MUST** receive gateway/adapter implementations via parameters.
- **MUST** return a result; **MUST NOT** call `process.exit` or write to stdio directly.

### Layer 3 — Adapters / Gateways (`src/adapters/`, `src/gateways/`)

Concrete implementations of Layer 2's interfaces. Where the outside world meets us.

- **MUST NOT** import from `cli.ts` or `bin.ts`.
- **MAY** import from `entities/` and from interfaces declared in `use-cases/`.
- **MAY** import npm packages and standard library I/O.
- One adapter per AI provider (`src/adapters/codex.ts`, etc.).
- One gateway per external concern (`src/gateways/filesystem.ts`, etc.).

### Layer 4 — Composition root (`src/cli.ts`, `src/bin.ts`)

Wires everything together. Translates argv → use-case calls → exit code.

- **MAY** import from any layer.
- **MUST NOT** contain business logic.

## The dependency rule

A file at layer N may import from layers 1..N-1. It may NOT import from layers N+1..4. Enforced by code review today; a `.dependency-cruiser.cjs` rule lands once entities + use-cases exist (post-F1).

## Naming & file layout

- One concept per file. Filename matches the primary export (kebab-case).
- Tests mirror source layout: `src/use-cases/audit.ts` ↔ `test/use-cases/audit.test.ts`.

## Error handling

- Define domain errors in `entities/errors.ts`.
- Gateways convert OS/network errors to domain errors before crossing the layer boundary.
- Use cases return errors as part of the result type or throw domain errors; never throw raw `Error`.
- Composition root translates domain errors to exit codes per [PRD §7](../../docs/PRD.md).

See [`.agents/instructions/software-architecture.md`](../../.agents/instructions/software-architecture.md) for the canonical full version with rationale and examples.
