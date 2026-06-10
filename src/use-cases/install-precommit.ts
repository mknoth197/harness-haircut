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
 *         --json`; a non-zero exit blocks the commit.
 *   - EV1 a repo using husky (a `.husky/` directory exists) → target
 *         `.husky/pre-commit` (husky already wires `.git/hooks` to run it).
 *   - EV2 otherwise → `.git/hooks/pre-commit`, made executable (chmod +x).
 *   - OPT1 `--force` overwrites an existing hook wholesale; without it, the
 *         tool APPENDS a fenced, marked block so re-runs are idempotent (the
 *         block is detected and not duplicated) and the block is removable by
 *         hand. An existing hook with no harness block is appended to; an
 *         existing hook that already carries the block is left untouched.
 *   - UN1 no `.git` directory → exit 3 (this is not a git repo).
 */

/** The hook line every installed pre-commit runs (U1). */
export const PRECOMMIT_COMMAND = 'npx harness-haircut audit --json';

/** Opening fence of the harness-managed block (OPT1 idempotency marker). */
export const PRECOMMIT_MARKER_START = '# >>> harness-haircut >>>';
/** Closing fence of the harness-managed block. */
export const PRECOMMIT_MARKER_END = '# <<< harness-haircut <<<';

/** Where the hook landed and what the install did to get it there. */
export interface InstallReport {
  /** Repo-relative POSIX path of the installed hook. */
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
 * All paths are repo-relative POSIX.
 */
export interface PrecommitGateway {
  /** EV1: true when a `.husky/` directory exists at the repo root. */
  huskyPresent(): boolean;
  /** UN1: true when a `.git` directory exists at the repo root. */
  gitPresent(): boolean;
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

/** Repo-relative POSIX paths of the two possible targets. */
const HUSKY_TARGET = '.husky/pre-commit';
const GIT_HOOKS_TARGET = '.git/hooks/pre-commit';

/**
 * The full content of a freshly-created hook: a shebang, a brief comment, and
 * the fenced harness block. `npx … audit --json` exits non-zero on drift or a
 * lossy warning, and a non-zero pre-commit hook aborts the commit (U1).
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
    PRECOMMIT_COMMAND,
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

  // UN1: refuse when this is not a git repo — there is no hooks directory to
  // install into, and a husky hook would never be invoked.
  if (!gateway.gitPresent()) {
    return { target: GIT_HOOKS_TARGET, action: 'unchanged', exitCode: 3 };
  }

  // EV1 / EV2: husky owns `.git/hooks` when present, so write the source hook
  // husky actually runs; otherwise write the git hook directly and chmod it.
  const husky = gateway.huskyPresent();
  const target = husky ? HUSKY_TARGET : GIT_HOOKS_TARGET;

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
