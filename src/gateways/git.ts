/**
 * Git gateway — C2 (#12), layer 3. Answers the single question `apply` needs
 * before it mutates disk: is the working tree dirty? (PRD §7 / C2 STATE1).
 *
 * Implemented by shelling out to `git status --porcelain` (acceptance
 * criterion: NOT a libgit dependency — keeps PRD goal 5's zero-runtime-deps
 * promise). `node:child_process.execFile` is used, never a shell, so no argv
 * is ever interpolated into a command string.
 *
 * Cleanliness contract:
 *   - `git status --porcelain` prints one line per changed/untracked path;
 *     EMPTY output means the tree is clean.
 *   - A non-git directory (or a missing `git` binary) means we CANNOT verify
 *     the tree is clean. `apply` would rather refuse than risk clobbering
 *     uncommitted work, so we treat "cannot verify" as DIRTY. The caller's
 *     `--allow-dirty` escape hatch then lets a user run outside git on
 *     purpose. (Documented in C2 STATE1.)
 */
import { execFile } from 'node:child_process';

/**
 * Returns `true` when the working tree at `cwd` has uncommitted changes
 * (tracked modifications, staged changes, or untracked files), OR when
 * cleanliness cannot be determined (not a git repo, `git` not installed) —
 * see the cannot-verify rule above. Returns `false` only when `git status
 * --porcelain` succeeds with empty output.
 */
export function isWorkingTreeDirty(cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      'git',
      ['status', '--porcelain'],
      { cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          // Non-zero exit (not a repo) or spawn failure (git missing): we
          // cannot confirm a clean tree, so report dirty for safety.
          resolve(true);
          return;
        }
        resolve(stdout.trim() !== '');
      },
    );
  });
}
