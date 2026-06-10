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
import { dirname, join } from 'node:path';
import type { PrecommitGateway } from '../use-cases/install-precommit.js';
import { FileSystemError } from '../entities/errors.js';

function toAbsolute(root: string, relPath: string): string {
  return join(root, ...relPath.split('/'));
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
    gitPresent(): boolean {
      // A `.git` directory is the common case; a `.git` *file* is a worktree
      // or submodule gitlink, which is still a git repo with hooks.
      const abs = join(root, '.git');
      try {
        return existsSync(abs);
      } catch (err) {
        throw new FileSystemError(abs, err);
      }
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
 * map plus boolean flags for husky/`.git` presence and a set recording which
 * paths were chmod-ed executable (so tests can assert the chmod call without a
 * real filesystem). Paths are repo-relative POSIX.
 */
export interface InMemoryPrecommitGateway extends PrecommitGateway {
  /** Current in-memory file contents, keyed by repo-relative POSIX path. */
  readonly files: Map<string, string>;
  /** Paths that `chmodExecutable` was called on. */
  readonly chmodded: Set<string>;
}

export function createInMemoryPrecommitGateway(init?: {
  husky?: boolean;
  git?: boolean;
  files?: Record<string, string>;
}): InMemoryPrecommitGateway {
  const files = new Map<string, string>(Object.entries(init?.files ?? {}));
  const chmodded = new Set<string>();
  const husky = init?.husky ?? false;
  const git = init?.git ?? true;
  return {
    files,
    chmodded,
    huskyPresent: () => husky,
    gitPresent: () => git,
    read: (path) => files.get(path) ?? null,
    write: (path, content) => {
      files.set(path, content);
    },
    chmodExecutable: (path) => {
      chmodded.add(path);
    },
  };
}
