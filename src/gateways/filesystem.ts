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

/**
 * OS / editor noise files and package-manager lockfiles that are never
 * AI-provider canonical content (#41). Skipped at any depth BEFORE the
 * `.gitignore` check, so they neither enter the IR (no HH-W010 "unknown
 * attachment under .agents/") nor — when a global rule like `.DS_Store` or
 * `*.lock` ignores one under `.agents/` — surface as HH-W012, whose remedy is
 * "un-ignore it": advising a user to un-ignore `.DS_Store` is actively wrong.
 * This is the file-level analogue of `node_modules`/`dist` already being
 * pruned unconditionally as directories — regenerable tooling, not content.
 */
const NON_CANONICAL_JUNK_NAMES: ReadonlySet<string> = new Set([
  '.DS_Store',
  '.AppleDouble',
  'Thumbs.db',
  'ehthumbs.db',
  'desktop.ini',
  'Desktop.ini',
  '.Spotlight-V100',
  '.Trashes',
  'package-lock.json',
  'npm-shrinkwrap.json',
  'yarn.lock',
  'pnpm-lock.yaml',
  'bun.lockb',
]);

/**
 * Suffix-matched junk: editor swap/backup files (vim `.swp`/`.swo`, emacs/gedit
 * `~`) and the broad `*.lock` family (Cargo.lock, Gemfile.lock, poetry.lock,
 * composer.lock, flake.lock, …) the exact-name set above does not enumerate.
 * These describe FILES, never directories — so they are matched only in the
 * file branch of `walk` (a legitimately-tracked directory named `build~` or
 * `vendor.lock` must not be silently pruned).
 */
const NON_CANONICAL_JUNK_FILE_SUFFIXES: readonly string[] = ['.swp', '.swo', '~', '.lock'];

/** Exact-name OS/VCS junk — checked for BOTH files and directories (e.g. `.Spotlight-V100`). */
function isJunkName(basename: string): boolean {
  return NON_CANONICAL_JUNK_NAMES.has(basename);
}

/** True for a junk FILE: an exact junk name OR an editor-swap / lockfile suffix (#41). */
function isNonCanonicalJunkFile(basename: string): boolean {
  return isJunkName(basename) || NON_CANONICAL_JUNK_FILE_SUFFIXES.some((s) => basename.endsWith(s));
}

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
 * SECURITY (ReDoS): a root `.gitignore` is attacker-controlled when onboarding
 * an untrusted repo. The hand-rolled glob-to-regex compiler used to emit one
 * `[^/]*` group per `*`; a single segment with N stars compiled to N adjacent
 * `[^/]*` groups — the classic catastrophic-backtracking shape (18 stars vs a
 * 29-char path took ~44s). The real fix is to COLLAPSE runs of consecutive `*`
 * within a segment to a single `[^/]*` at compile time (see
 * `segmentToRegexSource`): `***` is semantically identical to `*` (match any
 * run of non-`/`), so collapsing is correct AND removes the adjacent-unbounded-
 * quantifier shape entirely. The only line-level cap we still enforce is a
 * length cap (a pathological multi-kilobyte line cannot be a real ignore rule);
 * we keep a generous per-line wildcard sanity cap as defense-in-depth, but with
 * the collapse it is no longer load-bearing. A dropped line is surfaced (see
 * `noteDroppedLine`) so the user knows an ignore rule was skipped.
 */
const MAX_GITIGNORE_LINE_LENGTH = 1000;
const MAX_GITIGNORE_WILDCARDS = 50;

/**
 * NIT: dropping an over-complex `.gitignore` line silently can change ignore
 * verdicts (a path the user expected to be ignored is now walked). The matcher
 * lives in a gateway with no warning channel threaded through it, so we surface
 * the drop on stderr — minimal and side-channel-only, no signature change. A
 * one-time note per process keeps it from spamming a giant generated file.
 */
let droppedLineNoticeEmitted = false;
function noteDroppedLine(line: string): void {
  if (droppedLineNoticeEmitted) {
    return;
  }
  droppedLineNoticeEmitted = true;
  const preview = line.length > 60 ? `${line.slice(0, 60)}…` : line;
  process.stderr.write(
    `harness-haircut: skipped an over-complex .gitignore line (>${MAX_GITIGNORE_LINE_LENGTH} chars); ` +
      `ignore verdicts may differ from git. First skipped line: ${JSON.stringify(preview)}\n`,
  );
}

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
  // SECURITY: skip a pathological line before it reaches the regex compiler,
  // and surface the drop so a silently-changed ignore verdict is visible (NIT).
  if (tooComplexToCompile(trimmed)) {
    noteDroppedLine(trimmed);
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
 * A literal '**' that is not a standalone segment (e.g. 'a**b') is an
 * intra-segment '*' run: `segmentToRegexSource` collapses the run to a single
 * '[^/]*' (semantically identical to one '*'), which also removes the
 * catastrophic-backtracking shape. Only the '**' SEGMENT token (a whole path
 * segment, handled above) spans path separators; intra-segment runs never do.
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
  // SECURITY (ReDoS): collapse a run of consecutive intra-segment '*' into a
  // single '*' BEFORE splitting. Inside one path segment, '***' matches the
  // same set as '*' (any run of non-'/' chars), so this is semantically exact —
  // and it removes the adjacent-'[^/]*'-group shape that caused catastrophic
  // backtracking (N stars → N concatenated unbounded quantifiers). This only
  // touches '*' characters *within* a segment; the '**' globstar SEGMENT token
  // is handled separately in globToRegexSource and never reaches here.
  return segment
    .replace(/\*+/g, '*')
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
  /** #45: symlinked entries at a collected location the walk did not follow. */
  skippedSymlinks: string[];
}

async function walk(
  absDir: string,
  relDir: string,
  patterns: readonly IgnorePattern[],
  excludePatterns: readonly IgnorePattern[],
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
      // #41: OS-junk directories (.Spotlight-V100, .Trashes) are never content.
      // Exact names only — the suffix set (`.swp`/`~`/`.lock`) describes FILES,
      // so it must not silently prune a tracked dir like `build~` or `x.lock`.
      if (isJunkName(entry.name)) {
        continue;
      }
      // #42: a `exclude` config glob prunes the directory BEFORE the gitignore
      // check — it is an explicit "not canonical here", not a lost source, so
      // it earns no HH-W012 even when the path is also canonical-shaped.
      if (isIgnored(rel, true, excludePatterns)) {
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
      await walk(join(absDir, entry.name), rel, patterns, excludePatterns, include, state);
    } else if (entry.isFile()) {
      // #41: OS/editor noise + lockfiles are never canonical content — skip
      // BEFORE the ignore check so they fire neither HH-W010 (collected as an
      // unknown `.agents/` attachment) nor HH-W012 (whose "un-ignore it" advice
      // is wrong for a gitignored `.DS_Store`/lockfile). Files match the full
      // set (exact names + `.swp`/`.swo`/`~`/`.lock` suffixes).
      if (isNonCanonicalJunkFile(entry.name)) {
        continue;
      }
      // #42: an `exclude` config glob drops the file BEFORE the gitignore check
      // (explicit "not canonical", so no HH-W012 even if canonical-shaped).
      if (isIgnored(rel, false, excludePatterns)) {
        continue;
      }
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
    } else if (entry.isSymbolicLink()) {
      // #45: the walk NEVER follows a symlink (it could escape the repo or
      // cycle — the pen-test stance). A symlinked file/dir at a location we
      // would otherwise collect is therefore invisible to import. Record it
      // (when it passes the same junk/ignore/exclude/include gates a real entry
      // would) so `init` can surface a visible note instead of silently
      // dropping it. Junk / ignored / config-excluded links are skipped quietly
      // — the user already excluded them. A symlink is treated as a file for
      // matching (git tracks the link itself, not its target), so it uses the
      // file-level junk predicate (exact names + `.swp`/`~`/`.lock` suffixes).
      if (isNonCanonicalJunkFile(entry.name)) {
        continue;
      }
      if (isIgnored(rel, false, excludePatterns) || isIgnored(rel, false, patterns)) {
        continue;
      }
      // Record the link when its OWN path would be collected (a symlinked file),
      // OR when it is a collection ROOT whose descendants would be — e.g. a
      // symlinked `.claude` / `.github/instructions` / `.agents` dir, for which
      // `include(rel)` is false (the bare root is not itself a collected path)
      // but `include(rel + '/')` is true (gauntlet/Codex). Without the second
      // probe a symlinked root was still silently omitted — the #45 gap.
      if (include(rel) || include(`${rel}/`)) {
        state.skippedSymlinks.push(rel);
      }
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
 *
 * `exclude` (#42) is the config `exclude` list — gitignore-style globs whose
 * matches are dropped from collection BEFORE the ignore check, so they are not
 * detected, parsed, or projected into, and (unlike a `.gitignore` match) never
 * surface as HH-W012. Compiled once via the same glob subset as `.gitignore`.
 */
export async function readRepoSnapshot(root: string, exclude: readonly string[] = []): Promise<RepoSnapshot> {
  return snapshot(root, exclude, isCanonicalPath);
}

/**
 * Shared snapshot core for both readers: load the root `.gitignore`, compile
 * the config `exclude` globs once, walk under `include`, and finish. The two
 * public readers differ ONLY in the `include` predicate (canonical-only vs the
 * wider init set), so the gitignore/exclude compilation + WalkState boilerplate
 * lives here once.
 */
async function snapshot(
  root: string,
  exclude: readonly string[],
  include: (relPath: string) => boolean,
): Promise<RepoSnapshot> {
  const patterns = await loadRootGitignore(root);
  const excludePatterns = parseGitignore(exclude.join('\n'));
  const state: WalkState = { out: [], excludedCanonical: [], skippedSymlinks: [] };
  await walk(root, '', patterns, excludePatterns, include, state);
  return finishSnapshot(root, state);
}

/**
 * Wider snapshot for `init` (C3 onboarding): canonical sources PLUS the
 * provider-owned instruction/skill/hook files needed for `detectExisting` and
 * candidate recovery (see `isInitPath`). Same `.gitignore`/skip rules and
 * sorting as `readRepoSnapshot`; paths are repo-relative POSIX, BOM stripped.
 * Excluded canonical sources are still reported in `excludedCanonicalPaths`.
 * `exclude` (#42) drops config-excluded paths from collection, exactly as in
 * `readRepoSnapshot` — so init never adopts a fixture's provider files.
 */
export async function readInitSnapshot(root: string, exclude: readonly string[] = []): Promise<RepoSnapshot> {
  return snapshot(root, exclude, isInitPath);
}

/** Sort the collected files + deduped excluded-canonical / skipped-symlink paths into a snapshot. */
function finishSnapshot(root: string, state: WalkState): RepoSnapshot {
  const cmp = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
  state.out.sort((a, b) => cmp(a.path, b.path));
  const excludedCanonicalPaths = [...new Set(state.excludedCanonical)].sort(cmp);
  const skippedSymlinks = [...new Set(state.skippedSymlinks)].sort(cmp);
  return { root, files: state.out, excludedCanonicalPaths, skippedSymlinks };
}
