# C1 — `audit` command

**Type:** Command
**Depends on:** F1, F3, at least one adapter (A1 unblocks; full coverage needs A1–A4)
**Blocks:** C2 (apply reuses the comparison), I1
**Labels:** `enhancement`, `command`

## Context
[PRD §7](../PRD.md) describes `audit` as a read-only drift detector. It parses canonical sources, runs every enabled adapter to produce expected `EmittedFile[]`, then compares against disk. Exit codes are precisely defined (0 clean, 1 drift, 2 lossy-translation warning, 3 invalid config).

## Requirements (EARS)

- **U1.** The `audit` command shall make zero filesystem writes.
- **EV1.** When invoked with no flags, the command shall print a human-readable drift report to stdout and exit per the §7 exit-code table.
- **EV2.** When invoked with `--json`, the command shall emit a structured `AuditReport` JSON to stdout.
- **EV3.** When the canonical sources match disk byte-for-byte (after each adapter's expected projection), the command shall print `clean` and exit 0.
- **EV4.** When any adapter emits a lossy-translation warning, the command shall include those warnings in the report and exit 2 unless drift was also detected (drift takes precedence at exit 1).
- **OPT1.** Where `--strict` is set, the command shall escalate any warning (severity `'warn'`) to a drift-equivalent failure and exit 1.
- **UN1.** If the canonical sources fail to parse, then the command shall exit 3 with the parser's error message.

## Acceptance criteria

- [ ] Command implementation at `src/commands/audit.ts`.
- [ ] Tests cover: clean repo (exit 0), modified emitted file (exit 1), lossy warning only (exit 2), invalid config (exit 3), `--json` shape, `--strict` escalation.
- [ ] §16 success metric `audit exits 0 on a clean repo in <100ms` covered by a perf test (allowed to be marked `skip` until measurable).

## Out of scope
- Writing files (covered by C2).
- Interactive resolution (covered by C3).
