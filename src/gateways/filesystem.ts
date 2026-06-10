/**
 * Filesystem gateway — walks a repo and snapshots the canonical sources
 * (`AGENTS.md` at any depth, everything under root `.agents/`).
 * OS errors are converted to domain errors before crossing the layer
 * boundary (architecture rules).
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FileSnapshot, RepoSnapshot } from '../entities/adapter.js';
import { FileSystemError } from '../entities/errors.js';

/** Skipped unconditionally, at any depth, regardless of .gitignore. */
const ALWAYS_SKIPPED_DIRS: ReadonlySet<string> = new Set(['.git', 'node_modules', 'dist']);

interface IgnorePattern {
  regex: RegExp;
  /** Pattern ended with '/': matches directories only. */
  dirOnly: boolean;
  /** Pattern contains '/' (or led with one): matched against the full repo-relative path. */
  anchored: boolean;
}

/*
 * Minimal .gitignore subset (hand-rolled — zero runtime npm deps, PRD goal 5).
 * Supported:
 *   - blank lines and '#' comment lines (skipped)
 *   - simple names ('foo') — match the basename of any file or directory
 *   - directory patterns ('foo/') — match directories only
 *   - root-anchored patterns ('/foo', 'a/b') — any non-trailing '/' anchors
 *     the pattern to the repo root
 *   - '*' wildcards within a single path segment ([^/]*)
 * NOT supported (documented limitations):
 *   - '!' negation lines are skipped entirely, so re-included files stay
 *     ignored (conservative over-skip)
 *   - '**' collapses to a single-segment '*'; '?', character classes, and
 *     backslash escapes are treated as literal characters
 *   - nested .gitignore files and $GIT_DIR/info/exclude are not consulted
 */
function compilePattern(line: string): IgnorePattern | null {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('!')) {
    return null;
  }
  let pattern = trimmed;
  let dirOnly = false;
  if (pattern.endsWith('/')) {
    dirOnly = true;
    pattern = pattern.slice(0, -1);
  }
  let anchored = false;
  if (pattern.startsWith('/')) {
    anchored = true;
    pattern = pattern.slice(1);
  }
  if (pattern.includes('/')) {
    anchored = true;
  }
  const regexBody = pattern.split('/').map(segmentToRegexSource).join('/');
  return { regex: new RegExp(`^${regexBody}$`), dirOnly, anchored };
}

function segmentToRegexSource(segment: string): string {
  return segment
    .split('*')
    .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
}

function parseGitignore(content: string): IgnorePattern[] {
  return content
    .split('\n')
    .map(compilePattern)
    .filter((pattern): pattern is IgnorePattern => pattern !== null);
}

function isIgnored(relPath: string, isDir: boolean, patterns: readonly IgnorePattern[]): boolean {
  const basename = relPath.slice(relPath.lastIndexOf('/') + 1);
  return patterns.some((pattern) => {
    if (pattern.dirOnly && !isDir) {
      return false;
    }
    return pattern.regex.test(pattern.anchored ? relPath : basename);
  });
}

function isCanonicalPath(relPath: string): boolean {
  const basename = relPath.slice(relPath.lastIndexOf('/') + 1);
  return relPath.startsWith('.agents/') || basename === 'AGENTS.md';
}

async function loadRootGitignore(root: string): Promise<IgnorePattern[]> {
  let content: string;
  try {
    content = await readFile(join(root, '.gitignore'), 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return [];
    }
    throw new FileSystemError(join(root, '.gitignore'), err);
  }
  return parseGitignore(content);
}

async function walk(
  absDir: string,
  relDir: string,
  patterns: readonly IgnorePattern[],
  out: FileSnapshot[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(absDir, { withFileTypes: true });
  } catch (err) {
    throw new FileSystemError(absDir, err);
  }
  for (const entry of entries) {
    const rel = relDir === '' ? entry.name : `${relDir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (ALWAYS_SKIPPED_DIRS.has(entry.name)) {
        continue;
      }
      if (isIgnored(rel, true, patterns)) {
        continue;
      }
      await walk(join(absDir, entry.name), rel, patterns, out);
    } else if (entry.isFile()) {
      // Symlinks and special files are skipped: following links could
      // escape the repo or cycle, and canonical sources are plain files.
      if (isIgnored(rel, false, patterns) || !isCanonicalPath(rel)) {
        continue;
      }
      let content: string;
      try {
        content = await readFile(join(absDir, entry.name), 'utf8');
      } catch (err) {
        throw new FileSystemError(join(absDir, entry.name), err);
      }
      out.push({ path: rel, content });
    }
  }
}

/**
 * Snapshots every canonical source under `root`: `AGENTS.md` files at any
 * depth plus all files under the root `.agents/` directory. Always skips
 * `.git/`, `node_modules/`, and `dist/`; honors the root `.gitignore`
 * subset documented above. Paths are repo-relative POSIX, sorted.
 */
export async function readRepoSnapshot(root: string): Promise<RepoSnapshot> {
  const patterns = await loadRootGitignore(root);
  const files: FileSnapshot[] = [];
  await walk(root, '', patterns, files);
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return { root, files };
}
