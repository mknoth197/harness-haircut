# F2 — SignedSource header generator and verifier

**Type:** Foundational
**Depends on:** F0
**Blocks:** C2, C1 (audit reuses verifier)
**Labels:** `enhancement`, `foundation`

## Context
[PRD §9](../PRD.md) specifies that every file `harness-haircut` emits carries a `@generated SignedSource<<<HASH>>>` header so re-runs can detect both downstream user edits and upstream canonical changes. This story implements the hash function, header embedding, and verification.

## Requirements (EARS)

- **U1.** The module shall expose `embedHeader(body: string, sources: SourceManifest, syntax: CommentSyntax): string` and `verifyHeader(file: string): VerifyResult`.
- **U2.** The hash shall be computed as the lowercase hex of `SHA-256(body + "\n" + canonical(sources))`, truncated to the first 16 characters.
- **U3.** `canonical(sources)` shall sort entries by `path` and join `<path>:<sha256>` with `\n`.
- **U4.** `embedHeader` shall produce, as the file's first line: `@generated SignedSource<<<HASH>>> harness-haircut DO NOT EDIT` wrapped in the supplied `syntax` (HTML comment, `#`, `//`, etc.).
- **EV1.** When `verifyHeader` reads a file with an intact, matching header, it shall return `{ status: 'clean' }`.
- **EV2.** When `verifyHeader` reads a file whose body has been altered after emission, it shall return `{ status: 'edited' }`.
- **EV3.** When `verifyHeader` reads a file whose sources changed but body is verbatim from a prior emit, it shall return `{ status: 'stale' }`.
- **UN1.** If the file lacks a SignedSource header altogether, then `verifyHeader` shall return `{ status: 'unmanaged' }`.

## Acceptance criteria

- [ ] Module at `src/sign.ts`.
- [ ] Comment syntaxes supported: HTML, `#` (TOML/YAML), `//` (JSON-with-comments via tolerant parse — note: JSON proper has no comments; for `.claude/settings.json` etc. use the merge-policy approach from F3 instead of headers).
- [ ] Round-trip tests: `embedHeader → verifyHeader → 'clean'`.
- [ ] Mutation tests: edit body after embed → `'edited'`; change a source manifest entry → `'stale'`.
- [ ] Constants exported: `HEADER_TAG = '@generated SignedSource'`, `HASH_LEN = 16`.

## Out of scope
- The actual `apply` overwrite-prompt flow (covered by C2).
- JSON file management (handled via merge policy in F3 / per-adapter, not via header).
