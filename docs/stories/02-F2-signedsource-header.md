# F2 — SignedSource header generator and verifier

**Type:** Foundational
**Depends on:** F0
**Blocks:** C2, C1 (audit reuses verifier)
**Labels:** `enhancement`, `foundation`

## Context
[PRD §9](../PRD.md) specifies that every file `harness-haircut` emits carries a `@generated SignedSource<<<BODY_HASH.SOURCES_HASH>>>` header so re-runs can detect both downstream user edits and upstream canonical changes. Two separate hashes are required: a single combined hash cannot distinguish `edited` from `stale` at verify time (PRD §9 revision note). This story implements the hash functions, header embedding, and verification.

## Requirements (EARS)

- **U1.** The module shall expose `embedHeader(body: string, sources: SourceManifest, syntax: CommentSyntax): string` and `verifyHeader(file: string, currentSources: SourceManifest): VerifyResult`.
- **U2.** `BODY_HASH` shall be the lowercase hex of `SHA-256(body_after_header)`, truncated to the first 16 characters; `SOURCES_HASH` shall be the lowercase hex of `SHA-256(canonical(sources))`, truncated to the first 16 characters.
- **U3.** `canonical(sources)` shall sort entries by `path` and join `<path>:<sha256>` with `\n`.
- **U4.** `embedHeader` shall produce, as the file's first line: `@generated SignedSource<<<BODY_HASH.SOURCES_HASH>>> harness-haircut DO NOT EDIT` wrapped in the supplied `syntax` (HTML comment, `#`, `//`, etc.).
- **EV1.** When `verifyHeader` reads a file whose `BODY_HASH` matches the disk body and whose `SOURCES_HASH` matches the current manifest, it shall return `{ status: 'clean' }`.
- **EV2.** When `verifyHeader` reads a file whose body does not match `BODY_HASH`, it shall return `{ status: 'edited' }` (regardless of the sources hash).
- **EV3.** When `verifyHeader` reads a file whose body matches `BODY_HASH` but whose `SOURCES_HASH` does not match the current manifest, it shall return `{ status: 'stale' }`.
- **UN1.** If the file lacks a SignedSource header altogether, then `verifyHeader` shall return `{ status: 'unmanaged' }`.

## Acceptance criteria

- [ ] Module at `src/entities/signed-source.ts` (pure logic — `node:crypto` `createHash` is deterministic and I/O-free, so it belongs in the entities layer per `.agents/instructions/software-architecture.md`).
- [ ] Comment syntaxes supported: HTML, `#` (TOML/YAML), `//` (JS/TS). Files that take no header — one-line import shims and merge-key JSON targets — are governed by the PRD §9 carve-outs, not by this module.
- [ ] Round-trip tests: `embedHeader → verifyHeader → 'clean'`.
- [ ] Mutation tests: edit body after embed → `'edited'`; change a source manifest entry → `'stale'`; edit body AND change sources → `'edited'` (edited wins).
- [ ] Constants exported: `HEADER_TAG = '@generated SignedSource'`, `HASH_LEN = 16`.

## Out of scope
- The actual `apply` overwrite-prompt flow (covered by C2).
- JSON file management (handled via merge policy in F3 / per-adapter, not via header).
