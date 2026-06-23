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
 *
 * `write`/`remove` additionally refuse any path that is a git submodule root
 * (declared in the repo-root `.gitmodules`) or falls beneath one — a submodule
 * is a separate repository with its own canonical config, so the parent's
 * projection must never land a file inside it. This is defense-in-depth behind
 * the snapshot walk's submodule boundary.
 */
import {
  readFileSync,
  existsSync,
  statSync,
  lstatSync,
  realpathSync,
  writeFileSync,
  mkdirSync,
  rmSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import type { FileWriter } from '../entities/file-writer.js';
import { FileSystemError } from '../entities/errors.js';
import { parseGitmodules } from './filesystem.js';

function toAbsolute(root: string, relPath: string): string {
  return join(root, ...relPath.split('/'));
}

/**
 * SECURITY (realpath containment — the whole symlink chain): same rule the
 * provider-file reader and the snapshot walk enforce, now resolving the FULL
 * chain rather than only the leaf. A hostile repo could escape the tree two
 * ways: a symlinked leaf (CLAUDE.md → an external secret) OR a symlinked
 * PARENT dir (.github → /tmp/external) with an ordinary leaf behind it. The
 * old leaf-only `lstat` missed the second: a write to `.github/x.md` would
 * mkdir/write THROUGH the symlinked parent and clobber `/tmp/external/x.md`,
 * landing outside the repo (violating U1's adapter-declared-paths invariant).
 *
 * `read`/`exists` resolve the whole chain with `realpathSync` and require
 * containment (and reject a symlinked leaf outright, matching the walk).
 * `write` realpaths the DEEPEST EXISTING ANCESTOR directory and requires IT to
 * be contained BEFORE creating any directory — so mkdir can never run through
 * an escaping symlinked parent — then unlinks a symlinked leaf so the final
 * write lands as a real file strictly inside the repo.
 */
function realIfContained(realRoot: string, abs: string): string | null {
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
    return null;
  }
  return real;
}

/**
 * SECURITY + #35: resolve the deepest EXISTING ancestor directory of `abs`
 * and require its real path to be the ancestor path ITSELF — i.e. no symlink
 * anywhere in the parent chain. Walking up to the first directory that exists
 * lets a not-yet-created target (the common case for `write`) still be
 * validated. Two distinct refusals:
 *
 *   - the chain ESCAPES the repo (realpath lands outside `realRoot`): the
 *     original hostile-repo exfiltration case;
 *   - the chain stays IN-REPO but aliases another path (`.claude/skills/x` →
 *     `.agents/skills/x`): following it would land the write on the link's
 *     target — on real repos, the canonical source itself (#35).
 *
 * `audit`/`apply` consult `createSymlinkAliasProbe` first and skip + warn
 * (HH-W013) such targets, so for them this throw is a backstop; any future
 * caller that forgets the probe fails loudly here instead of clobbering.
 */
function assertParentContained(realRoot: string, abs: string): void {
  let ancestor = dirname(abs);
  // dirname() is a fixpoint at the filesystem root ('/'), so this terminates.
  for (;;) {
    if (existsSync(ancestor)) {
      let realAncestor: string;
      try {
        realAncestor = realpathSync(ancestor);
      } catch (err) {
        throw new FileSystemError(ancestor, err);
      }
      if (realAncestor === ancestor) {
        return;
      }
      if (realAncestor === realRoot || realAncestor.startsWith(realRoot + sep)) {
        throw new FileSystemError(
          abs,
          new Error(
            `refusing to write through an in-repo symlinked parent: ${abs} would land ` +
              `at ${realAncestor + abs.slice(ancestor.length)} (remove the symlink so the ` +
              'write can land at its own path)',
          ),
        );
      }
      throw new FileSystemError(
        abs,
        new Error(
          `refusing to write through a path that escapes repo root ${realRoot}: ${abs}`,
        ),
      );
    }
    const parent = dirname(ancestor);
    if (parent === ancestor) {
      // Reached the filesystem root without finding an existing ancestor —
      // impossible when rooted under realRoot, but bail rather than loop.
      return;
    }
    ancestor = parent;
  }
}

/**
 * Builds the #35 alias probe: given a repo-relative POSIX path, returns the
 * path's REAL location when its parent chain traverses a symlink —
 * `.claude/skills/x/SKILL.md` behind a symlinked skill dir resolves to
 * `.agents/skills/x/SKILL.md` — or `null` when the chain is symlink-free.
 * The returned path is repo-relative POSIX when the target stays inside the
 * repo, or the absolute OS path when it escapes (callers skip both; the
 * writer refuses both). The LEAF is deliberately not probed: `write` replaces
 * a symlinked leaf with a real file in place, which aliases nothing — only a
 * traversed parent re-roots the write onto the link's target.
 *
 * `audit` and `apply` consult this before reading or planning any provider
 * path, so an aliased target is skipped + warned (HH-W013) instead of read
 * and written through — which on real repos overwrote the canonical source
 * and broke apply→audit idempotency (#35).
 */
export function createSymlinkAliasProbe(root: string): (relPath: string) => string | null {
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch (err) {
    throw new FileSystemError(root, err);
  }
  return (relPath: string): string | null => {
    const abs = toAbsolute(realRoot, relPath);
    let ancestor = dirname(abs);
    // Walk up to the deepest existing ancestor (dirname is a fixpoint at '/').
    for (;;) {
      let realAncestor: string | null = null;
      try {
        realAncestor = realpathSync(ancestor);
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        // ENOENT: this ancestor does not exist yet (target being created) —
        // keep walking up. ENOTDIR: a file occupies a parent segment; no
        // symlink chain to alias through (mkdir will fail loudly later).
        if (code !== 'ENOENT' && code !== 'ENOTDIR') {
          throw new FileSystemError(ancestor, err);
        }
      }
      if (realAncestor !== null) {
        if (realAncestor === ancestor) {
          return null;
        }
        const landing = realAncestor + abs.slice(ancestor.length);
        return landing === realRoot || landing.startsWith(realRoot + sep)
          ? landing.slice(realRoot.length + 1).split(sep).join('/')
          : landing;
      }
      const parent = dirname(ancestor);
      if (parent === ancestor) {
        return null;
      }
      ancestor = parent;
    }
  };
}

/**
 * SECURITY: assert the write target stays inside the repo root by NAME (before
 * any filesystem access). Callers pass repo-relative POSIX paths, but a `..`
 * segment or an absolute path would escape the tree (e.g. `init` writing
 * recovered content, or a future caller deriving a path from untrusted input).
 * We resolve against `realRoot` and require the result to be the root itself
 * or a descendant. This is the lexical first line of defense; the realpath
 * ancestor check (assertParentContained) then closes symlinked-parent escapes.
 */
function assertContained(realRoot: string, relPath: string): string {
  // Resolve the path as-given (not split into segments): an ABSOLUTE relPath
  // then wins over root and resolves outside it (correctly rejected below), and
  // any `..` segment is normalized so an escape is detectable.
  const abs = resolve(realRoot, relPath);
  if (abs !== realRoot && !abs.startsWith(realRoot + sep)) {
    throw new FileSystemError(
      abs,
      new Error(`refusing to write outside repo root ${realRoot}: ${relPath}`),
    );
  }
  // Return the segment-joined absolute path so POSIX relPaths map to the OS
  // separator exactly as `toAbsolute` (the prior behavior) produced them.
  return toAbsolute(realRoot, relPath);
}

/**
 * Loads the repo-root `.gitmodules` submodule working-tree paths (repo-relative
 * POSIX), tolerating a missing/empty file. Synchronous to fit the writer's
 * sync construction; uses the SAME parser the snapshot walk uses so the two
 * cannot disagree about what counts as a submodule boundary.
 */
function loadSubmodulePathsSync(realRoot: string): readonly string[] {
  let content: string;
  try {
    content = readFileSync(join(realRoot, '.gitmodules'), 'utf8');
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'EISDIR') {
      return [];
    }
    throw new FileSystemError(join(realRoot, '.gitmodules'), err);
  }
  return parseGitmodules(content);
}

/**
 * SECURITY + submodule boundaries: refuse to write/remove a path that is a
 * submodule root or falls beneath one. A submodule is a separate repository
 * with its own canonical config, so the parent's projection must never land a
 * file inside it. This is defense-in-depth alongside the snapshot's walk
 * boundary: even if a path slips past collection (a future caller, a hand-built
 * `EmittedFile`), nothing is ever written into a submodule tree. `relPath` is
 * the lexically-contained repo-relative POSIX path (already `..`/absolute-safe).
 */
function assertNotUnderSubmodule(
  realRoot: string,
  relPath: string,
  submodulePaths: readonly string[],
): void {
  // Normalize the candidate the way the snapshot's `rel` paths are shaped:
  // POSIX separators, no leading './', no trailing '/'.
  let rel = relPath.replace(/\\/g, '/');
  while (rel.startsWith('./')) {
    rel = rel.slice(2);
  }
  while (rel.endsWith('/')) {
    rel = rel.slice(0, -1);
  }
  for (const sub of submodulePaths) {
    if (rel === sub || rel.startsWith(`${sub}/`)) {
      throw new FileSystemError(
        toAbsolute(realRoot, relPath),
        new Error(
          `refusing to write inside git submodule '${sub}': ${relPath} — a submodule is a ` +
            'separate repository with its own canonical config; manage its files there.',
        ),
      );
    }
  }
}

/** Creates a `FileWriter` over the real filesystem rooted at `root`. */
export function createFileWriter(root: string): FileWriter {
  // `root` is trusted; resolve it once so containment compares real paths
  // against a real root (the root may itself sit behind a symlink such as
  // macOS /var → /private/var, and every target realpath would too).
  let realRoot: string;
  try {
    realRoot = realpathSync(root);
  } catch (err) {
    throw new FileSystemError(root, err);
  }
  // Submodule roots are read once at construction (the writer outlives a single
  // call). Reads/exists are unaffected — only the two MUTATORS are guarded, so
  // verify-reads still work, but no write/remove can land inside a submodule.
  const submodulePaths = loadSubmodulePathsSync(realRoot);
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
      // reported absent (consistent with read).
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
    write(relPath: string, content: string): void {
      // SECURITY: lexical containment first — reject `..`/absolute escapes
      // before any filesystem access (throws FileSystemError).
      const abs = assertContained(realRoot, relPath);
      // Submodule boundary: refuse to write a submodule root or anything under
      // one (defense-in-depth — nothing is ever written into a separate repo).
      assertNotUnderSubmodule(realRoot, relPath, submodulePaths);
      // SECURITY: then realpath the deepest existing ancestor and require it is
      // inside realRoot BEFORE mkdir, so we never create directories or write
      // through an escaping symlinked parent (the symlinked-parent-dir bypass).
      assertParentContained(realRoot, abs);
      try {
        mkdirSync(dirname(abs), { recursive: true });
        // SECURITY: if a symlink already occupies the target leaf, remove the
        // LINK (not its target) so we write a real file inside the repo rather
        // than following the link out to corrupt an external file.
        if (lstatExistsSymlink(abs)) {
          rmSync(abs);
        }
        writeFileSync(abs, content, 'utf8');
      } catch (err) {
        throw new FileSystemError(abs, err);
      }
    },
    remove(relPath: string): void {
      // SECURITY: the same two-step containment `write` uses — lexical escape
      // rejected first, then the deepest existing ancestor must realpath inside
      // realRoot — so an `rm` can never follow a symlinked parent out of the
      // repo and delete an external file. `rmSync` on a symlinked leaf removes
      // the LINK (never its target); `force` makes a missing file a no-op so
      // callers need not pre-check existence.
      const abs = assertContained(realRoot, relPath);
      // Submodule boundary: never remove a submodule root or a path under one.
      assertNotUnderSubmodule(realRoot, relPath, submodulePaths);
      assertParentContained(realRoot, abs);
      try {
        rmSync(abs, { force: true });
      } catch (err) {
        throw new FileSystemError(abs, err);
      }
    },
  };
}

/** True when `abs` exists and is a symlink (false on ENOENT). */
function lstatExistsSymlink(abs: string): boolean {
  try {
    return lstatSync(abs).isSymbolicLink();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    throw new FileSystemError(abs, err);
  }
}
