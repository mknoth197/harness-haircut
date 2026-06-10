# Security Policy

## Supported versions

Pre-1.0: only the latest published version receives fixes.

## Reporting a vulnerability

Please **do not** open a public issue for security reports. Instead, use
[GitHub private vulnerability reporting](https://github.com/mknoth197/harness-haircut/security/advisories/new)
on this repository.

You can expect an acknowledgement within a week. Please include a minimal
reproduction and the version (`npx harness-haircut --version`).

## Scope notes

`harness-haircut` reads and writes configuration files inside a single
repository working tree. It does not execute hooks (it only generates hook
*configuration* for other tools), does not make network calls at runtime, and
has no runtime npm dependencies. Reports about the security of the configs it
*emits* (e.g., a generated hook command that a provider would execute) are in
scope and especially appreciated.
