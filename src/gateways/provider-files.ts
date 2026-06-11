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
import { readFileSync, existsSync, statSync, lstatSync, realpathSync } from 'node:fs';
import { join, sep } from 'node:path';
import type { ProviderFileReader } from '../entities/adapter.js';
import { FileSystemError } from '../entities/errors.js';

function toAbsolute(root: string, relPath: string): string {
  return join(root, ...relPath.split('/'));
}

/**
 * SECURITY (realpath containment — the whole symlink chain): `init` reads the
 * fixed root-instruction paths (AGENTS.md, CLAUDE.md, GEMINI.md,
 * .github/copilot-instructions.md) through this reader and recovers their
 * content into canonical AGENTS.md, which is then projected into every
 * provider file and committed. A malicious repo could escape the tree in two
 * ways: a symlinked *leaf* (CLAUDE.md → ~/.ssh/id_rsa) OR — the case the leaf
 * lstat missed — a symlinked *parent dir* (.github → /tmp/external) with a
 * perfectly ordinary real leaf behind it. `readFileSync` follows the WHOLE
 * chain and would exfiltrate the target either way.
 *
 * So we resolve the target's real path with `realpathSync` (which collapses
 * every symlink in the chain, parents included, and also closes the
 * lstat→read TOCTOU) and require it to be `realRoot` itself or strictly
 * beneath it. Anything outside → treated as ABSENT (null / exists=false).
 *
 * We additionally keep the STRICTER "never follow ANY symlink" stance for the
 * leaf: even a symlink whose target is *inside* the repo reads as absent. That
 * matches the snapshot walk in `filesystem.ts` (which skips symlinked entries
 * outright), so the reader and the walk now agree exactly.
 */
function realIfContained(realRoot: string, abs: string): string | null {
  // Reject a symlinked LEAF outright (stricter than containment alone, to
  // match the snapshot walk's "skip any symlink"). A non-existent path has no
  // link; any other lstat error surfaces as a FileSystemError.
  try {
    if (lstatSync(abs).isSymbolicLink()) {
      return null;
    }
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      return null;
    }
    throw new FileSystemError(abs, err);
  }
  // Resolve the whole chain (parents included) and require containment. The
  // file must exist to be read, so realpathSync is well-defined here; ENOENT /
  // ENOTDIR (a symlinked parent that vanished, etc.) read as absent.
  let real: string;
  try {
    real = realpathSync(abs);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR') {
      return null;
    }
    throw new FileSystemError(abs, err);
  }
  if (real !== realRoot && !real.startsWith(realRoot + sep)) {
    // Escapes the repo (symlinked parent dir, symlinked leaf target, or `..`
    // trick) → treat as absent so the secret behind it is never read.
    return null;
  }
  return real;
}

/**
 * Creates a `ProviderFileReader` over the real filesystem rooted at `root`.
 * `read` strips a leading UTF-8 BOM so downstream first-line/frontmatter
 * checks are not masked by an invisible byte (matching the canonical-source
 * gateway).
 */
export function createProviderFileReader(root: string): ProviderFileReader {
  // `root` itself is trusted; resolve it once so containment compares real
  // paths against a real root (the repo's own root may sit behind a symlink,
  // e.g. /var → /private/var on macOS, and every target realpath would too).
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch (err) {
    throw new FileSystemError(root, err);
  }
  return {
    read(relPath: string): string | null {
      const abs = toAbsolute(realRoot, relPath);
      // SECURITY: only read a target whose whole chain stays inside realRoot
      // and whose leaf is not itself a symlink (see realIfContained).
      const real = realIfContained(realRoot, abs);
      if (real === null) {
        return null;
      }
      let content: string;
      try {
        content = readFileSync(real, 'utf8');
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        // ENOENT (absent) and EISDIR (a directory sits at the path) both
        // mean "no file content here" — read as null rather than throwing.
        if (code === 'ENOENT' || code === 'EISDIR') {
          return null;
        }
        throw new FileSystemError(real, err);
      }
      return content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
    },
    exists(relPath: string): boolean {
      const abs = toAbsolute(realRoot, relPath);
      // SECURITY: a target that escapes the repo or whose leaf is a symlink is
      // reported absent so callers never act on something they would refuse to
      // read.
      const real = realIfContained(realRoot, abs);
      if (real === null) {
        return false;
      }
      try {
        return existsSync(real) && statSync(real).isFile();
      } catch (err) {
        throw new FileSystemError(real, err);
      }
    },
  };
}
