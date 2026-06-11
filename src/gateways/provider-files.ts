/**
 * Filesystem-backed `ProviderFileReader` — C1 (#11), layer 3.
 *
 * The adapter PR (F3) stubbed this seam with `createFileReader(record)` (a
 * pure in-memory reader for unit tests); this is the real implementation,
 * rooted at a repo `cwd`. It is read-only — `audit` makes zero writes
 * (C1 U1) — and is used both to feed adapters' `detectExisting`/`project`
 * (so they can make merge decisions and refuse malformed configs) and to
 * read on-disk emitted files for drift comparison.
 *
 * Paths are repo-relative POSIX (the same convention as `EmittedFile.path`);
 * they are resolved against `root` and read synchronously so the reader
 * matches the synchronous `ProviderFileReader` contract. Any error other
 * than "file does not exist" is converted to a `FileSystemError` before it
 * crosses the layer boundary (architecture rules); a directory at the path,
 * like a missing file, reads as `null`.
 */
import { readFileSync, existsSync, statSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import type { ProviderFileReader } from '../entities/adapter.js';
import { FileSystemError } from '../entities/errors.js';

function toAbsolute(root: string, relPath: string): string {
  return join(root, ...relPath.split('/'));
}

/**
 * SECURITY: never read *through* a symlink. `init` reads the fixed
 * root-instruction paths (AGENTS.md, CLAUDE.md, GEMINI.md,
 * .github/copilot-instructions.md) through this reader and recovers their
 * content into canonical AGENTS.md, which is then projected into every
 * provider file and committed. A malicious repo could point one of those
 * paths at, e.g., ~/.ssh/id_rsa or ~/.aws/credentials; `readFileSync` follows
 * symlinks and would exfiltrate the target. So we `lstat` first and treat any
 * symlink as ABSENT (return null / exists=false) — exactly how the snapshot
 * walk in `filesystem.ts` skips symlinked entries. A missing path (ENOENT)
 * also has no link, so this is purely additive over the prior behavior.
 */
function isSymlink(abs: string): boolean {
  try {
    return lstatSync(abs).isSymbolicLink();
  } catch (err) {
    // ENOENT (nothing there) → not a symlink; any other error surfaces below
    // when the real read/stat is attempted (or via FileSystemError).
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw new FileSystemError(abs, err);
  }
}

/**
 * Creates a `ProviderFileReader` over the real filesystem rooted at `root`.
 * `read` strips a leading UTF-8 BOM so downstream first-line/frontmatter
 * checks are not masked by an invisible byte (matching the canonical-source
 * gateway).
 */
export function createProviderFileReader(root: string): ProviderFileReader {
  return {
    read(relPath: string): string | null {
      const abs = toAbsolute(root, relPath);
      // SECURITY: a symlink reads as absent — never follow it (see isSymlink).
      if (isSymlink(abs)) {
        return null;
      }
      let content: string;
      try {
        content = readFileSync(abs, 'utf8');
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        // ENOENT (absent) and EISDIR (a directory sits at the path) both
        // mean "no file content here" — read as null rather than throwing.
        if (code === 'ENOENT' || code === 'EISDIR') {
          return null;
        }
        throw new FileSystemError(abs, err);
      }
      return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
    },
    exists(relPath: string): boolean {
      const abs = toAbsolute(root, relPath);
      // SECURITY: a symlink (even one pointing at a real file) is reported as
      // absent so callers never act on a link they would refuse to read.
      if (isSymlink(abs)) {
        return false;
      }
      try {
        return existsSync(abs) && statSync(abs).isFile();
      } catch (err) {
        throw new FileSystemError(abs, err);
      }
    },
  };
}
