/**
 * Filesystem-backed `FileWriter` — C2 (#12), layer 3. The mutating
 * counterpart to `createProviderFileReader`: `apply` does every disk change
 * through this seam. Rooted at a repo `cwd`; paths are repo-relative POSIX
 * (same convention as `EmittedFile.path`).
 *
 * `write` creates parent directories as needed and replaces any existing
 * file wholesale (matching the `FileWriter` contract). Reads/exists mirror
 * the provider-file reader so the same root can answer both the verify reads
 * and the writes. OS errors are converted to `FileSystemError` before they
 * cross the layer boundary (architecture rules); a directory at a read path,
 * like a missing file, reads as `null`.
 */
import {
  readFileSync,
  existsSync,
  statSync,
  lstatSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { FileWriter } from '../entities/file-writer.js';
import { FileSystemError } from '../entities/errors.js';

function toAbsolute(root: string, relPath: string): string {
  return join(root, ...relPath.split('/'));
}

/**
 * SECURITY: never read/write *through* a symlink — same rule the provider-file
 * reader and the snapshot walk enforce. A hostile repo could point an owned
 * path (e.g. CLAUDE.md, a co-owned settings.json) at an out-of-repo secret;
 * following the link on read would exfiltrate it, and following it on write
 * would corrupt the external target. `read`/`exists` therefore treat a symlink
 * as absent, and `write` unlinks an existing symlink first so it lays down a
 * real file *inside* the repo instead of following the link out.
 */
function isSymlink(abs: string): boolean {
  try {
    return lstatSync(abs).isSymbolicLink();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw new FileSystemError(abs, err);
  }
}

/**
 * SECURITY: assert the write target stays inside the repo root. Callers pass
 * repo-relative POSIX paths, but a `..` segment or an absolute path would
 * escape the tree (e.g. `init` writing recovered content, or a future caller
 * deriving a path from untrusted input). We resolve against the (resolved)
 * root and require the result to be the root itself or a descendant of it.
 * Throwing here keeps the single mutation surface from ever writing outside
 * the repo it was rooted at.
 */
function assertContained(root: string, relPath: string): string {
  const resolvedRoot = resolve(root);
  // Resolve the path as-given (not split into segments): an ABSOLUTE relPath
  // then wins over root and resolves outside it (correctly rejected below), and
  // any `..` segment is normalized so an escape is detectable.
  const abs = resolve(resolvedRoot, relPath);
  if (abs !== resolvedRoot && !abs.startsWith(resolvedRoot + sep)) {
    throw new FileSystemError(
      abs,
      new Error(`refusing to write outside repo root ${resolvedRoot}: ${relPath}`),
    );
  }
  // Return the segment-joined absolute path so POSIX relPaths map to the OS
  // separator exactly as `toAbsolute` (the prior behavior) produced them.
  return toAbsolute(resolvedRoot, relPath);
}

/** Creates a `FileWriter` over the real filesystem rooted at `root`. */
export function createFileWriter(root: string): FileWriter {
  return {
    read(relPath: string): string | null {
      const abs = toAbsolute(root, relPath);
      // SECURITY: a symlinked target reads as absent — never follow it.
      if (isSymlink(abs)) {
        return null;
      }
      let content: string;
      try {
        content = readFileSync(abs, 'utf8');
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'EISDIR') {
          return null;
        }
        throw new FileSystemError(abs, err);
      }
      return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
    },
    exists(relPath: string): boolean {
      const abs = toAbsolute(root, relPath);
      // SECURITY: a symlink is reported absent (consistent with read).
      if (isSymlink(abs)) {
        return false;
      }
      try {
        return existsSync(abs) && statSync(abs).isFile();
      } catch (err) {
        throw new FileSystemError(abs, err);
      }
    },
    write(relPath: string, content: string): void {
      // SECURITY: reject any relPath that escapes the repo root before we
      // touch the disk (throws FileSystemError; see assertContained).
      const abs = assertContained(root, relPath);
      try {
        mkdirSync(dirname(abs), { recursive: true });
        // SECURITY: if a symlink already occupies the target, remove the LINK
        // (not its target) so we write a real file inside the repo rather than
        // following the link out to corrupt an external file.
        if (isSymlink(abs)) {
          rmSync(abs);
        }
        writeFileSync(abs, content, 'utf8');
      } catch (err) {
        throw new FileSystemError(abs, err);
      }
    },
  };
}
