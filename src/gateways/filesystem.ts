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

export interface IgnorePattern {
  regex: RegExp;
  /** Pattern ended with '/': matches directories only. */
  dirOnly: boolean;
  /** Pattern contains '/' (or led with one): matched against the full repo-relative path. */
  anchored: boolean;
  /** Started with '!': re-includes a path an earlier pattern excluded. */
  negated: boolean;
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
 *   - '!' negation lines — a later pattern re-includes a path excluded by an
 *     earlier one. Last matching pattern wins (git semantics). Honored with
 *     git's caveat: a negation cannot re-include a file beneath a directory
 *     that is itself excluded, because the walk prunes excluded directories
 *     and never descends into them (see `walk`).
 *   - multi-segment double-star globs. A trailing double-star (foo then
 *     slash then star-star) matches everything below foo; a leading
 *     star-star-slash (star-star then slash then bar) matches bar at any
 *     depth; an interior double-star (a then slash-star-star-slash then b)
 *     matches both a/b and a/x/y/b. A bare double-star segment matches zero
 *     or more path segments.
 * NOT supported (documented limitations):
 *   - '?', character classes ('[a-z]'), and backslash escapes are treated as
 *     literal characters
 *   - nested .gitignore files and $GIT_DIR/info/exclude are not consulted
 *     (root .gitignore only)
 */
/**
 * SECURITY (ReDoS cap): a root `.gitignore` is attacker-controlled when
 * onboarding an untrusted repo. The hand-rolled glob-to-regex compiler emits a
 * single-segment or multi-segment matcher group per `*` / `**`; a line with
 * very many wildcards can produce a regex that backtracks super-linearly.
 * Lines that are implausibly long, or that pack in an unreasonable number of
 * wildcard chars, cannot be a real ignore rule — so we skip them (uncompiled)
 * rather than risk a hang. Generous limits keep every legitimate pattern working.
 */
const MAX_GITIGNORE_LINE_LENGTH = 1000;
const MAX_GITIGNORE_WILDCARDS = 50;

function tooComplexToCompile(line: string): boolean {
  if (line.length > MAX_GITIGNORE_LINE_LENGTH) {
    return true;
  }
  let wildcards = 0;
  for (const ch of line) {
    if (ch === '*') {
      wildcards++;
    }
  }
  return wildcards > MAX_GITIGNORE_WILDCARDS;
}

function compilePattern(line: string): IgnorePattern | null {
  const trimmed = line.trim();
  if (trimmed === '' || trimmed.startsWith('#')) {
    return null;
  }
  // SECURITY: skip a pathological line before it reaches the regex compiler.
  if (tooComplexToCompile(trimmed)) {
    return null;
  }
  let pattern = trimmed;
  let negated = false;
  if (pattern.startsWith('!')) {
    negated = true;
    pattern = pattern.slice(1);
  }
  let dirOnly = false;
  if (pattern.endsWith('/')) {
    dirOnly = true;
    pattern = pattern.slice(0, -1);
  }
  if (pattern === '') {
    return null;
  }
  let anchored = false;
  if (pattern.startsWith('/')) {
    anchored = true;
    pattern = pattern.slice(1);
  }
  // A '/' anywhere other than a trailing slash anchors the pattern to the
  // repo root (git rule). Leading '**/' does not anchor — it stays a
  // match-at-any-depth pattern — so detect a "real" interior slash first.
  if (hasAnchoringSlash(pattern)) {
    anchored = true;
  }
  return { regex: new RegExp(`^${globToRegexSource(pattern)}$`), dirOnly, anchored, negated };
}

/**
 * True when the pattern contains a slash that anchors it to the repo root.
 * A leading double-star-slash is the one slash that does NOT anchor (git: it
 * means "in this dir or any subdir"), so strip one leading globstar prefix
 * before looking for an anchoring slash.
 */
function hasAnchoringSlash(pattern: string): boolean {
  const withoutLeadingGlobstar = pattern.startsWith('**/') ? pattern.slice(3) : pattern;
  return withoutLeadingGlobstar.includes('/');
}

/**
 * Compiles a gitignore glob (already stripped of leading '!', leading '/',
 * and trailing '/') into a regex source. Splits on '/' so that a whole '**'
 * segment becomes a multi-segment matcher and '*' stays single-segment
 * ([^/]*). Git's three globstar shapes are honored:
 *   - leading globstar ('foo' at any depth): a zero-or-more-segment prefix
 *     group precedes the rest of the pattern.
 *   - trailing globstar ('everything inside foo'): the head is followed by a
 *     mandatory separator and one-or-more remaining path chars.
 *   - interior globstar ('a' … 'b' with anything between): a mandatory
 *     separator after the head, then a zero-or-more-segment group, then the
 *     tail — matching 'a/b' (zero between) and 'a/x/y/b' but not 'ab'.
 * A literal '**' that is not a standalone segment (e.g. 'a**b') degrades to
 * the single-segment '*' behavior for each star, which is acceptable for the
 * canonical-source patterns we care about.
 */
function globToRegexSource(pattern: string): string {
  // Collapse runs of consecutive '**' segments into a single '**' first:
  // 'a/**/**/b' is semantically identical to 'a/**/b', and the per-segment
  // emitter below would otherwise stitch two globstar groups together into a
  // dead regex containing a literal '//' that no normalized path can match.
  const segments = collapseGlobstars(pattern.split('/'));
  let out = '';
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i] ?? '';
    const isFirst = i === 0;
    const isLast = i === segments.length - 1;
    if (segment === '**') {
      if (isLast) {
        // Trailing globstar ('foo' then slash-star-star): everything strictly
        // inside foo, ≥1 segment. The previous segment skipped its join slash
        // (its successor is this globstar), so supply the separator here.
        out += isFirst ? '.+' : '/.+';
      } else if (isFirst) {
        // Leading globstar ('star-star/<rest>'): zero-or-more leading whole
        // segments. The group ends in '/', so it also supplies the separator
        // before the next segment — no join slash after it.
        out += '(?:.*/)?';
        continue;
      } else {
        // Interior globstar ('a' … star-star … 'b'): the preceding segment
        // skipped its join slash, so require that separator here, then a
        // zero-or-more-whole-segments group. The result matches 'a/b' and
        // 'a/x/y/b' but not the single fused component 'ab'.
        out += '/(?:.*/)?';
        continue;
      }
    } else {
      out += segmentToRegexSource(segment);
    }
    // Emit a path separator before the next segment, unless that next
    // segment is a globstar whose own prefix group already supplies it.
    if (!isLast && segments[i + 1] !== '**') {
      out += '/';
    }
  }
  return out;
}

/**
 * Drops each '**' segment that immediately follows another '**', leaving one
 * globstar per run. Git treats a run of adjacent globstars (a, then two
 * globstar segments, then b) as identical to a single one (a, one globstar,
 * b); a run left intact would compile to a regex with a literal '//' that no
 * normalized path can match (a dead pattern).
 */
function collapseGlobstars(segments: string[]): string[] {
  return segments.filter(
    (segment, i) => !(segment === '**' && segments[i - 1] === '**'),
  );
}

function segmentToRegexSource(segment: string): string {
  return segment
    .split('*')
    .map((literal) => literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
    .join('[^/]*');
}

export function parseGitignore(content: string): IgnorePattern[] {
  return content
    .split('\n')
    .map(compilePattern)
    .filter((pattern): pattern is IgnorePattern => pattern !== null);
}

/**
 * Last-matching-pattern-wins verdict for `relPath`. A negated pattern that
 * matches flips the verdict back to "not ignored"; a later non-negated match
 * flips it back. Returns the final boolean after walking every pattern.
 *
 * The directory-exclusion caveat (a negation cannot resurrect a file under an
 * excluded directory) is enforced by the walk, not here: `walk` prunes a
 * directory whose verdict is "ignored", so files beneath it are never tested.
 *
 * Contract: this assumes the walk's incremental, segment-by-segment descent.
 * An unanchored parent-directory pattern (e.g. `build`) takes effect because
 * the walk tests — and prunes — that directory as it descends, NOT because a
 * deep path is tested standalone (`build/x/y.md` is never asked about once
 * `build/` is pruned). Callers must therefore drive `isIgnored` via the walk
 * (testing each path component as it is reached), not on arbitrary deep paths.
 */
export function isIgnored(
  relPath: string,
  isDir: boolean,
  patterns: readonly IgnorePattern[],
): boolean {
  const basename = relPath.slice(relPath.lastIndexOf('/') + 1);
  let ignored = false;
  for (const pattern of patterns) {
    // A dir-only pattern can still re-include via negation? No: dir-only
    // patterns only apply to directories. Skip non-matching file/dir kinds.
    if (pattern.dirOnly && !isDir) {
      continue;
    }
    const target = pattern.anchored ? relPath : basename;
    if (pattern.regex.test(target)) {
      ignored = !pattern.negated;
    }
  }
  return ignored;
}

export function isCanonicalPath(relPath: string): boolean {
  const basename = relPath.slice(relPath.lastIndexOf('/') + 1);
  return relPath.startsWith('.agents/') || basename === 'AGENTS.md';
}

/**
 * True when a pruned directory sits on the canonical `.agents/` path — the
 * root `.agents/` tree itself or any directory beneath it. Excluding such a
 * directory loses canonical content we can attribute precisely, so it earns
 * an HH-W012 (EV1). A pruned non-`.agents` directory *might* hold a nested
 * `AGENTS.md`, but git's rule is that an excluded directory's contents are
 * excluded, and scanning a user-ignored tree to find out would defeat the
 * ignore rule — so those are left unreported by design (documented limit).
 */
function dirIsCanonicalAnchor(relPath: string): boolean {
  return relPath === '.agents' || relPath.startsWith('.agents/');
}

/**
 * Wider inclusion for `init` (C3): canonical sources PLUS the provider-owned
 * instruction and skill files `detectExisting` and candidate recovery need —
 * `CLAUDE.md` / `GEMINI.md` shims, the Copilot review files, and the Claude /
 * Codex / Gemini / Copilot config trees that hold skills and hook configs.
 * `RepoSnapshot` is documented to allow callers to widen collection this way.
 */
function isInitPath(relPath: string): boolean {
  if (isCanonicalPath(relPath)) {
    return true;
  }
  const basename = relPath.slice(relPath.lastIndexOf('/') + 1);
  return (
    basename === 'CLAUDE.md' ||
    basename === 'GEMINI.md' ||
    relPath === '.github/copilot-instructions.md' ||
    relPath.startsWith('.github/instructions/') ||
    relPath.startsWith('.github/hooks/') ||
    relPath.startsWith('.claude/') ||
    relPath.startsWith('.codex/') ||
    relPath.startsWith('.gemini/')
  );
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

interface WalkState {
  out: FileSnapshot[];
  /** Canonical-shaped paths excluded by an ignore rule (drives HH-W012). */
  excludedCanonical: string[];
}

async function walk(
  absDir: string,
  relDir: string,
  patterns: readonly IgnorePattern[],
  include: (relPath: string) => boolean,
  state: WalkState,
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
        // Git never descends into an excluded directory, so canonical
        // sources beneath it are lost. Surface the exclusion instead of
        // silently skipping (EV1). We report the directory path; the
        // root `.agents/` exclusion is the headline case.
        // Known limit: a canonical file inside a fully-ignored *non-`.agents`*
        // directory (e.g. `vendor/AGENTS.md`) is intentionally out of scope —
        // we honor the directory ignore rather than enumerating ignored trees,
        // so no HH-W012 fires for it (see docs/warnings/HH-W012.md).
        if (dirIsCanonicalAnchor(rel)) {
          recordExcludedCanonicalDir(rel, state);
        }
        continue;
      }
      await walk(join(absDir, entry.name), rel, patterns, include, state);
    } else if (entry.isFile()) {
      // Symlinks and special files are skipped: following links could
      // escape the repo or cycle, and canonical sources are plain files.
      if (isIgnored(rel, false, patterns)) {
        // A canonical source the user asked git to ignore: surface it (EV1)
        // rather than silently dropping it from the IR. Tracking is keyed to
        // canonical paths regardless of the (possibly wider) include filter.
        if (isCanonicalPath(rel)) {
          state.excludedCanonical.push(rel);
        }
        continue;
      }
      if (!include(rel)) {
        continue;
      }
      let content: string;
      try {
        content = await readFile(join(absDir, entry.name), 'utf8');
      } catch (err) {
        throw new FileSystemError(join(absDir, entry.name), err);
      }
      // Strip a leading UTF-8 BOM (common from Windows editors) so parsers
      // downstream see clean content — a BOM before `---` would otherwise
      // hide frontmatter.
      if (content.charCodeAt(0) === 0xfeff) {
        content = content.slice(1);
      }
      state.out.push({ path: rel, content });
    }
  }
}

/**
 * Records a pruned canonical directory as a trailing-slash path so the
 * warning points at the lost subtree. Excluding the root `.agents/` empties
 * the IR (the headline EV1 case); excluding a subdirectory under it loses
 * just that subtree. We report the directory anchor rather than enumerating
 * its files, because descending into a user-ignored tree to list them would
 * defeat the very ignore rule that pruned it.
 */
function recordExcludedCanonicalDir(rel: string, state: WalkState): void {
  state.excludedCanonical.push(`${rel}/`);
}

/**
 * Snapshots every canonical source under `root`: `AGENTS.md` files at any
 * depth plus all files under the **root** `.agents/` directory (nested
 * `<dir>/.agents/` directories are not collected). Always skips `.git/`,
 * `node_modules/`, and `dist/`; honors the root `.gitignore` subset
 * documented above. Paths are repo-relative POSIX, sorted; a leading UTF-8
 * BOM is stripped from file contents.
 *
 * When a canonical-shaped path is excluded by an ignore rule it is reported
 * in `excludedCanonicalPaths` (sorted) rather than silently dropped; the
 * `parseRepo` use case maps those into `HH-W012` warnings (EV1).
 */
export async function readRepoSnapshot(root: string): Promise<RepoSnapshot> {
  const patterns = await loadRootGitignore(root);
  const state: WalkState = { out: [], excludedCanonical: [] };
  await walk(root, '', patterns, isCanonicalPath, state);
  return finishSnapshot(root, state);
}

/**
 * Wider snapshot for `init` (C3 onboarding): canonical sources PLUS the
 * provider-owned instruction/skill/hook files needed for `detectExisting` and
 * candidate recovery (see `isInitPath`). Same `.gitignore`/skip rules and
 * sorting as `readRepoSnapshot`; paths are repo-relative POSIX, BOM stripped.
 * Excluded canonical sources are still reported in `excludedCanonicalPaths`.
 */
export async function readInitSnapshot(root: string): Promise<RepoSnapshot> {
  const patterns = await loadRootGitignore(root);
  const state: WalkState = { out: [], excludedCanonical: [] };
  await walk(root, '', patterns, isInitPath, state);
  return finishSnapshot(root, state);
}

/** Sort the collected files + deduped excluded-canonical paths into a snapshot. */
function finishSnapshot(root: string, state: WalkState): RepoSnapshot {
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  state.out.sort((a, b) => cmp(a.path, b.path));
  const excludedCanonicalPaths = [...new Set(state.excludedCanonical)].sort(cmp);
  return { root, files: state.out, excludedCanonicalPaths };
}
