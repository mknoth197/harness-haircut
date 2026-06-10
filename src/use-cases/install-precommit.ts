/**
 * `install-precommit` use case — I1 (#14), PRD §13. Layer 2: pure orchestration
 * with an injected gateway. It DECIDES the target hook path and the content to
 * write; it performs NO I/O itself — every disk touch (husky detection, `.git`
 * presence, read/write/chmod of the hook file) goes through the injected
 * `PrecommitGateway`. It never calls `process.exit` and never touches stdio; it
 * returns an `InstallReport` and the composition root (layer 4) maps the exit
 * code and renders output.
 *
 * Behavior (EARS, story 11 / PRD §13):
 *   - U1  the command installs a hook that runs `npx harness-haircut audit
 *         --json`; a DRIFT (exit 1) or config error (exit 3) blocks the commit,
 *         a clean tree (exit 0) lets it through, and an informational lossy
 *         warning (exit 2) does NOT block — a standing `HH-Wxxx` is a persistent
 *         property of a canonical config, so blocking on it would wedge every
 *         commit forever on a repo with no drift.
 *   - EV1 a repo using husky (a `.husky/` directory exists) → target
 *         `.husky/pre-commit` (husky already wires the hooks dir to run it).
 *   - EV2 otherwise → the repo's real hooks directory (resolved by the gateway
 *         via `git rev-parse --git-path hooks`, so a worktree or submodule
 *         gitlink — where `.git` is a FILE, not a directory — resolves to the
 *         correct hooks dir rather than crashing on a non-directory
 *         `.git/hooks`). The hook is made executable (chmod +x).
 *   - OPT1 `--force` overwrites an existing hook wholesale; without it, the
 *         tool APPENDS a fenced, marked block so re-runs are idempotent (the
 *         block is detected and not duplicated) and the block is removable by
 *         hand. An existing hook with no harness block is appended to; an
 *         existing hook that already carries the block is left untouched.
 *   - UN1 not a git repo (or `git` unavailable, so the hooks dir cannot be
 *         resolved) → exit 3.
 */

/** The audit command every installed pre-commit runs (U1). */
export const PRECOMMIT_COMMAND = 'npx harness-haircut audit --json';

/**
 * The exit code `audit` returns for an informational lossy-translation warning
 * (PRD §7: 0 clean · 1 drift · 2 lossy-warning · 3 invalid config). The hook
 * treats it as non-blocking — see `precommitHookCommand`.
 */
export const AUDIT_WARNING_EXIT = 2;

/**
 * The POSIX-sh snippet the hook runs (U1). It runs `audit --json`, then maps
 * the audit exit code to a commit-block decision: a lossy-only warning
 * (exit 2) is informational and MUST NOT block — a standing `HH-Wxxx` is a
 * persistent property of canonical config, so blocking on it would wedge every
 * commit on a drift-free repo. Drift (exit 1) and config errors (exit 3) still
 * block; a clean tree (exit 0) passes.
 */
export function precommitHookCommand(): string {
  return [
    PRECOMMIT_COMMAND,
    'rc=$?',
    `if [ "$rc" = ${AUDIT_WARNING_EXIT} ]; then exit 0; fi`,
    'exit $rc',
  ].join('\n');
}

/** Opening fence of the harness-managed block (OPT1 idempotency marker). */
export const PRECOMMIT_MARKER_START = '# >>> harness-haircut >>>';
/** Closing fence of the harness-managed block. */
export const PRECOMMIT_MARKER_END = '# <<< harness-haircut <<<';

/** Where the hook landed and what the install did to get it there. */
export interface InstallReport {
  /**
   * POSIX path of the installed hook, as understood by the gateway. For a
   * husky hook this is the repo-relative `.husky/pre-commit`; for a plain hook
   * it is `<resolved-hooks-dir>/pre-commit`, where the directory is whatever
   * the gateway resolved (normally `.git/hooks`, but a worktree/submodule
   * gitlink resolves elsewhere).
   */
  target: string;
  /**
   * 'created'     — no hook existed; a fresh hook file was written.
   * 'overwritten' — `--force` replaced an existing hook wholesale.
   * 'appended'    — the harness block was appended to an existing hook.
   * 'unchanged'   — the harness block was already present (idempotent re-run).
   */
  action: 'created' | 'overwritten' | 'appended' | 'unchanged';
  /** PRD §7: 0 success · 3 not a git repo. */
  exitCode: 0 | 3;
}

/**
 * The disk seam for `install-precommit`. The real implementation lives in
 * `src/gateways/precommit.ts`; tests use a pure in-memory implementation.
 * The husky target is repo-relative POSIX; the resolved hooks dir may be any
 * POSIX path the gateway hands back (it round-trips it through read/write/chmod).
 */
export interface PrecommitGateway {
  /** EV1: true when a `.husky/` directory exists at the repo root. */
  huskyPresent(): boolean;
  /**
   * EV2/UN1: the repo's real git hooks directory (POSIX path), or `null` when
   * this is not a git repo or `git` is unavailable so the directory cannot be
   * resolved. Resolves correctly for worktrees and submodules, where `.git` is
   * a file rather than a directory.
   */
  resolveGitHooksDir(): string | null;
  /** Reads a hook file's content, or `null` when it does not exist. */
  read(path: string): string | null;
  /** Writes the hook file wholesale, creating parent directories as needed. */
  write(path: string, content: string): void;
  /** EV2: marks the hook executable (no-op on platforms without exec bits). */
  chmodExecutable(path: string): void;
}

export interface InstallPrecommitFlags {
  /** OPT1: overwrite an existing hook wholesale instead of appending. */
  force: boolean;
}

export interface InstallPrecommitDeps {
  gateway: PrecommitGateway;
  flags: InstallPrecommitFlags;
}

/** Repo-relative POSIX path of the husky target (the git target is resolved). */
const HUSKY_TARGET = '.husky/pre-commit';
/** Hook filename appended to the resolved hooks directory for a plain hook. */
const HOOK_FILENAME = 'pre-commit';

/**
 * The full content of a freshly-created hook: a shebang, a brief comment, and
 * the fenced harness block. The block runs `audit --json` and blocks the commit
 * on drift (exit 1) or a config error (exit 3); a lossy-only warning (exit 2)
 * does not block (U1, `precommitHookCommand`).
 */
function freshHook(): string {
  return [
    '#!/usr/bin/env sh',
    block(),
    '',
  ].join('\n');
}

/** The fenced, marked harness block (OPT1) appended to existing hooks. */
function block(): string {
  return [
    PRECOMMIT_MARKER_START,
    '# Managed by harness-haircut. Re-run `harness-haircut install-precommit`',
    '# to refresh, or delete the lines between the markers to remove.',
    '# Blocks on drift (exit 1) or config error (exit 3); a lossy-translation',
    '# warning (exit 2) is informational and does not block the commit.',
    precommitHookCommand(),
    PRECOMMIT_MARKER_END,
  ].join('\n');
}

/** True when `content` already carries a (complete) harness-managed block. */
function hasBlock(content: string): boolean {
  return content.includes(PRECOMMIT_MARKER_START) && content.includes(PRECOMMIT_MARKER_END);
}

/**
 * Appends the harness block to an existing hook, separated by a blank line so
 * it reads cleanly. The caller guarantees no block is present yet.
 */
function appendBlock(existing: string): string {
  // Normalize the seam: exactly one blank line between the prior content and
  // the block, and a trailing newline after it.
  const trimmed = existing.replace(/\n+$/, '');
  return `${trimmed}\n\n${block()}\n`;
}

export function installPrecommit(deps: InstallPrecommitDeps): InstallReport {
  const { gateway, flags } = deps;

  // EV1 / EV2: husky owns the hooks dir when present, so write the source hook
  // husky actually runs; otherwise write the git hook directly and chmod it.
  const husky = gateway.huskyPresent();

  let target: string;
  if (husky) {
    target = HUSKY_TARGET;
  } else {
    // EV2 / UN1: resolve the repo's real hooks dir (correct for worktrees and
    // submodules, where `.git` is a file). A null result means this is not a
    // git repo or `git` is unavailable — refuse with exit 3 rather than writing
    // into a path that does not exist.
    const hooksDir = gateway.resolveGitHooksDir();
    if (hooksDir === null) {
      return { target: `.git/hooks/${HOOK_FILENAME}`, action: 'unchanged', exitCode: 3 };
    }
    target = `${hooksDir.replace(/\/+$/, '')}/${HOOK_FILENAME}`;
  }

  const existing = gateway.read(target);

  let content: string;
  let action: InstallReport['action'];

  if (existing === null) {
    content = freshHook();
    action = 'created';
  } else if (flags.force) {
    // OPT1: --force overwrites wholesale.
    content = freshHook();
    action = 'overwritten';
  } else if (hasBlock(existing)) {
    // Idempotent re-run: the block is already there, so do not duplicate it.
    // Still (re-)chmod below so a hook that lost its exec bit is repaired.
    content = existing;
    action = 'unchanged';
  } else {
    // OPT1: append the fenced block, preserving the user's existing hook.
    content = appendBlock(existing);
    action = 'appended';
  }

  if (action !== 'unchanged') {
    gateway.write(target, content);
  }

  // EV2: a plain `.git/hooks` hook must be executable to run. Husky's own
  // runner invokes `.husky/pre-commit`, but an exec bit there is harmless and
  // keeps `sh .husky/pre-commit` working, so chmod both. Re-chmod even on an
  // unchanged run to repair a hook that lost its bit.
  gateway.chmodExecutable(target);

  return { target, action, exitCode: 0 };
}
