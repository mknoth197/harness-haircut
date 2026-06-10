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
import { readFileSync, existsSync, statSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import type { FileWriter } from '../entities/file-writer.js';
import { FileSystemError } from '../entities/errors.js';

function toAbsolute(root: string, relPath: string): string {
  return join(root, ...relPath.split('/'));
}

/** Creates a `FileWriter` over the real filesystem rooted at `root`. */
export function createFileWriter(root: string): FileWriter {
  return {
    read(relPath: string): string | null {
      const abs = toAbsolute(root, relPath);
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
      try {
        return existsSync(abs) && statSync(abs).isFile();
      } catch (err) {
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
  };
}
