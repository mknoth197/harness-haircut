/**
 * Pre-commit hook gateway — I1 (#14), layer 3. The concrete `PrecommitGateway`
 * the `install-precommit` use case is injected with: husky/`.git` detection,
 * and read/write/chmod of the hook file over the real filesystem. The use case
 * stays pure; every disk touch lives here. OS errors are converted to
 * `FileSystemError` before crossing the layer boundary (architecture rules).
 *
 * A pure in-memory implementation (`createInMemoryPrecommitGateway`) lives
 * here too so unit tests can exercise the use case's decision logic without an
 * `os.tmpdir()` fixture — the integration tests drive the real gateway.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, statSync, chmodSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, join } from 'node:path';
import type { PrecommitGateway } from '../use-cases/install-precommit.js';
import { FileSystemError } from '../entities/errors.js';

/**
 * Resolves a path the gateway round-trips through read/write/chmod against the
 * repo `root`. A POSIX-relative path (the husky target, or a `git rev-parse`
 * result relative to cwd) is split and re-joined under `root`; an absolute path
 * (some worktrees report one) is used verbatim.
 */
function toAbsolute(root: string, p: string): string {
  if (isAbsolute(p)) {
    return p;
  }
  return join(root, ...p.split('/'));
}

/**
 * The repo's real git hooks directory, resolved via `git rev-parse --git-path
 * hooks` (run with cwd at `root`). This returns the correct directory for a
 * normal repo (`.git/hooks`), a worktree, and a submodule — including the case
 * where `.git` is a FILE (a gitlink) rather than a directory, which a literal
 * `<root>/.git/hooks` join would turn into an ENOTDIR crash. Returns `null`
 * when `git` is unavailable or this is not a git repo, so the use case can
 * surface a clear domain error instead of failing later on a bad path.
 */
function resolveHooksDir(root: string): string | null {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], {
      cwd: root,
      encoding: 'utf8',
    });
    const trimmed = out.trim();
    return trimmed === '' ? null : trimmed;
  } catch {
    // `git` missing (spawn failure) or not a repo (non-zero exit): cannot
    // resolve, so report null. The use case maps this to its exit-3 path.
    return null;
  }
}

function dirExists(absPath: string): boolean {
  try {
    return existsSync(absPath) && statSync(absPath).isDirectory();
  } catch (err) {
    throw new FileSystemError(absPath, err);
  }
}

/** Creates a `PrecommitGateway` over the real filesystem rooted at `root`. */
export function createPrecommitGateway(root: string): PrecommitGateway {
  return {
    huskyPresent(): boolean {
      return dirExists(join(root, '.husky'));
    },
    resolveGitHooksDir(): string | null {
      // Ask git for the real hooks dir so worktrees/submodules (where `.git` is
      // a file) resolve correctly instead of crashing on a non-dir `.git/hooks`.
      return resolveHooksDir(root);
    },
    read(relPath: string): string | null {
      const abs = toAbsolute(root, relPath);
      try {
        return readFileSync(abs, 'utf8');
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'EISDIR') {
          return null;
        }
        throw new FileSystemError(abs, err);
      }
    },
    write(relPath: string, content: string): void {
      const abs = toAbsolute(root, relPath);
      try {
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content, 'utf8');
      } catch (err) {
        throw new FileSystemError(abs, err);
      }
    },
    chmodExecutable(relPath: string): void {
      const abs = toAbsolute(root, relPath);
      try {
        // Mirror the bit pattern git uses for its own sample hooks: 0o755.
        // chmod is a no-op on Windows (mode bits are synthesized from the
        // extension), so this is harmless there.
        chmodSync(abs, 0o755);
      } catch (err) {
        throw new FileSystemError(abs, err);
      }
    },
  };
}

/**
 * Pure in-memory `PrecommitGateway` for unit tests. Backed by a path → content
 * map plus flags for husky presence and the resolved hooks dir, and a set
 * recording which paths were chmod-ed executable (so tests can assert the chmod
 * call without a real filesystem). Paths are repo-relative POSIX.
 */
export interface InMemoryPrecommitGateway extends PrecommitGateway {
  /** Current in-memory file contents, keyed by repo-relative POSIX path. */
  readonly files: Map<string, string>;
  /** Paths that `chmodExecutable` was called on. */
  readonly chmodded: Set<string>;
}

export function createInMemoryPrecommitGateway(init?: {
  husky?: boolean;
  /**
   * Whether this is a (resolvable) git repo. `true` (default) resolves to
   * `.git/hooks`; `false` resolves to `null` (the not-a-repo / no-git case).
   */
  git?: boolean;
  /**
   * Overrides the resolved hooks dir — e.g. a worktree's
   * `.git/worktrees/foo/hooks`. Takes precedence over `git` when set.
   */
  hooksDir?: string;
  files?: Record<string, string>;
}): InMemoryPrecommitGateway {
  const files = new Map<string, string>(Object.entries(init?.files ?? {}));
  const chmodded = new Set<string>();
  const husky = init?.husky ?? false;
  const git = init?.git ?? true;
  const hooksDir = init?.hooksDir ?? (git ? '.git/hooks' : null);
  return {
    files,
    chmodded,
    huskyPresent: () => husky,
    resolveGitHooksDir: () => hooksDir,
    read: (path) => files.get(path) ?? null,
    write: (path, content) => {
      files.set(path, content);
    },
    chmodExecutable: (path) => {
      chmodded.add(path);
    },
  };
}
