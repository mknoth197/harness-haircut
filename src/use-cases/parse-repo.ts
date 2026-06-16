/**
 * parseRepo — F1 (#4): lifts a repo snapshot into the canonical IR.
 * Layer 2: receives the gateway via `deps` (dependency injection from the
 * composition root); assembly logic is pure and throws only domain errors.
 */
import type { FileSnapshot, RepoSnapshot } from '../entities/adapter.js';
import { APPLY_STATE_PATH } from '../entities/apply-state.js';
import { AggregateParseError, ParseError } from '../entities/errors.js';
import type { Attachment, Hook, IR, Instruction, Skill } from '../entities/ir.js';
import { HOOK_EVENTS, isHookEvent, SAFE_NAME_RE } from '../entities/ir.js';
import type { Warning } from '../entities/warnings.js';

export interface ParseRepoDeps {
  readRepo: () => Promise<RepoSnapshot>;
}

export interface ParseRepoResult {
  ir: IR;
  warnings: Warning[];
}

type FrontmatterValue = string | string[];

interface Frontmatter {
  present: boolean;
  data: Record<string, FrontmatterValue>;
  /** Content after the closing delimiter (the whole file when absent). */
  body: string;
  /**
   * Verbatim frontmatter interior — the lines BETWEEN the `---` fences, joined
   * with `\n` (empty when no frontmatter is present). Lets a caller reproduce
   * the block faithfully rather than re-serializing the parsed `data` (which
   * would normalize quoting/order). The Claude skill projection relies on this
   * to carry provider-specific keys through verbatim (#38).
   */
  raw: string;
}

/*
 * Minimal YAML-subset frontmatter parser (hand-rolled — zero runtime npm
 * deps, PRD goal 5). Supported, which is all the canonical format needs
 * for `scope` / `name` / `description`:
 *   - `key: scalar` — scalars may be single- or double-quoted (quotes are
 *     stripped; no escape processing inside them)
 *   - `key: [a, b]` inline arrays of unquoted scalars
 *   - `key:` followed by `- item` block-sequence lines
 *   - blank lines and full-line `#` comments
 *   - ` #` inside a cleanly-quoted scalar (`description: "fix issue #12"`)
 *     is literal text — YAML cannot start a comment inside quotes (#36)
 * Rejected (exit code 3, F1 UN2) rather than silently mis-parsed:
 *   - UNQUOTED values containing ` #` — YAML trailing comments are outside
 *     the supported subset, and providers genuinely mis-parse these (Claude
 *     Code truncates an unquoted description at the `#`)
 *   - inline array items containing `"` or `'` — quoted items may embed
 *     commas, which the comma-split cannot handle faithfully
 *   - anything else (nested maps, multi-line scalars, anchors, …)
 */
function parseFrontmatter(content: string, filePath: string): Frontmatter {
  const lines = content.split('\n');
  if ((lines[0] ?? '').trimEnd() !== '---') {
    return { present: false, data: emptyData(), body: content, raw: '' };
  }
  let end = -1;
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? '').trimEnd() === '---') {
      end = i;
      break;
    }
  }
  if (end === -1) {
    throw new ParseError(filePath, 'unterminated frontmatter block (missing closing "---")');
  }

  const data = emptyData();
  let i = 1;
  while (i < end) {
    const line = (lines[i] ?? '').trimEnd();
    const lineNo = i + 1;
    i += 1;
    if (line.trim() === '' || line.trim().startsWith('#')) {
      continue;
    }
    const keyMatch = /^([A-Za-z0-9_-]+):(.*)$/.exec(line);
    if (keyMatch === null) {
      throw new ParseError(filePath, `malformed frontmatter at line ${lineNo}: "${line.trim()}"`);
    }
    const key = keyMatch[1] ?? '';
    const rest = (keyMatch[2] ?? '').trim();
    if (!isCleanlyQuoted(rest)) {
      rejectTrailingComment(rest, key, lineNo, filePath);
    }
    if (rest === '') {
      const items: string[] = [];
      while (i < end) {
        const itemMatch = /^-\s+(.+)$/.exec((lines[i] ?? '').trim());
        if (itemMatch === null) {
          break;
        }
        const item = (itemMatch[1] ?? '').trim();
        if (!isCleanlyQuoted(item)) {
          rejectTrailingComment(item, key, i + 1, filePath);
        }
        items.push(unquote(item));
        i += 1;
      }
      if (items.length === 0) {
        throw new ParseError(filePath, `frontmatter key "${key}" (line ${lineNo}) has no value`);
      }
      data[key] = items;
    } else if (rest.startsWith('[')) {
      if (!rest.endsWith(']')) {
        throw new ParseError(filePath, `malformed inline array for frontmatter key "${key}" (line ${lineNo})`);
      }
      const inner = rest.slice(1, -1).trim();
      data[key] =
        inner === ''
          ? []
          : inner.split(',').map((item) => {
              const trimmed = item.trim();
              if (trimmed.includes('"') || trimmed.includes("'")) {
                throw new ParseError(
                  filePath,
                  `inline array for frontmatter key "${key}" (line ${lineNo}) contains quoted ` +
                    'items, which are outside the supported subset (quotes may embed commas ' +
                    'the comma-split cannot handle faithfully)',
                );
              }
              return trimmed;
            });
    } else {
      data[key] = unquote(rest);
    }
  }
  return {
    present: true,
    data,
    body: lines.slice(end + 1).join('\n'),
    raw: lines.slice(1, end).join('\n'),
  };
}

/** Prototype-pollution insurance: frontmatter keys land on a null-prototype record. */
function emptyData(): Record<string, FrontmatterValue> {
  return Object.create(null) as Record<string, FrontmatterValue>;
}

/**
 * True for a value that is ONE cleanly-quoted scalar: it starts and ends with
 * the same quote character and the interior never repeats it. Inside such a
 * scalar, ` #` is literal text — YAML cannot open a comment inside quotes —
 * so the trailing-comment rejection must not apply (#36). Anything murkier
 * (an interior quote, e.g. `"a" #x"`, where the ` #` may genuinely be a
 * comment after a closed scalar) stays subject to the strict rejection.
 */
function isCleanlyQuoted(value: string): boolean {
  if (value.length < 2) {
    return false;
  }
  const quote = value[0];
  if (quote !== '"' && quote !== "'") {
    return false;
  }
  return value.endsWith(quote) && !value.slice(1, -1).includes(quote);
}

/** The subset has no trailing-comment support; silently keeping the text would mis-parse. */
function rejectTrailingComment(value: string, key: string, lineNo: number, filePath: string): void {
  if (value.includes(' #')) {
    throw new ParseError(
      filePath,
      `value for frontmatter key "${key}" (line ${lineNo}) contains " #": ` +
        'YAML comments are outside the supported subset. Double-quote the whole ' +
        `value to keep a literal " #" (e.g. ${key}: "fixes issue #12"), or reword it`,
    );
  }
}

function unquote(value: string): string {
  if (
    value.length >= 2 &&
    ((value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'")))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

/** F1 EV1 + UN1: AGENTS.md is pure markdown; frontmatter warns and stays literal. */
function parseAgentsMd(file: FileSnapshot, warnings: Warning[]): Instruction {
  if (hasFrontmatterBlock(file.content)) {
    warnings.push({
      code: 'HH-W011',
      severity: 'warn',
      message:
        `${file.path} begins with a YAML frontmatter block; native consumers inject ` +
        'AGENTS.md verbatim, so the block leaks into provider prompts. ' +
        'It is treated as literal content.',
      canonicalPath: file.path,
    });
  }
  const slashAt = file.path.lastIndexOf('/');
  const dir = slashAt === -1 ? '' : file.path.slice(0, slashAt);
  return {
    path: file.path,
    scope: dir === '' ? '**' : `${dir}/**`,
    body: file.content,
  };
}

/**
 * HH-W011 only fires for a real frontmatter block: a closing `---` must
 * exist (a lone leading `---` is a markdown thematic break, not frontmatter)
 * and the block must be non-empty (`---\n---` carries nothing that could
 * leak into provider prompts).
 */
function hasFrontmatterBlock(content: string): boolean {
  const lines = content.split('\n');
  if ((lines[0] ?? '').trimEnd() !== '---') {
    return false;
  }
  for (let i = 1; i < lines.length; i++) {
    if ((lines[i] ?? '').trimEnd() === '---') {
      return i > 1;
    }
  }
  return false;
}

/** F1 EV2 + UN5: scoped fragments require `scope:` frontmatter. */
function parseInstructionFragment(file: FileSnapshot): Instruction {
  const fm = parseFrontmatter(file.content, file.path);
  const scope = fm.data['scope'];
  if (!fm.present || scope === undefined) {
    throw new ParseError(
      file.path,
      'missing required "scope:" frontmatter key (scope is what distinguishes a fragment from prose)',
    );
  }
  if (typeof scope !== 'string' || scope === '') {
    throw new ParseError(file.path, '"scope:" must be a non-empty glob string');
  }
  return { path: file.path, scope, body: fm.body };
}

const HOOK_SCRIPT_EXTENSIONS: ReadonlySet<string> = new Set(['sh', 'js']);

/**
 * A file in `.agents/hooks/` is **hook-shaped** iff its basename has at
 * least three dot-segments (`<event>.<name>.<ext>`), its final extension is
 * a script extension (`sh`/`js`), and no segment is empty (rejects dotfiles
 * like `.DS_Store` and trailing-dot names like `pre-tool-use.lint.`).
 * Everything else — READMEs, `.gitkeep`, `*.bak`, and `.toml`/`.json` files
 * (reserved for the future sibling-metadata convention, PRD §8, which is not
 * yet designed) — is an opaque attachment + HH-W010 (F1 EV5).
 */
function isHookShaped(basename: string): boolean {
  const segments = basename.split('.');
  return (
    segments.length >= 3 &&
    HOOK_SCRIPT_EXTENSIONS.has(segments[segments.length - 1] ?? '') &&
    segments.every((segment) => segment !== '')
  );
}

/**
 * B3: hook basenames end up interpolated into provider shell commands
 * (e.g. Claude's `$CLAUDE_PROJECT_DIR/<path>`), so any shell metacharacter
 * — space, backtick, `$(`, quotes, … — would be a command-injection vector.
 */
const HOOK_BASENAME_UNSAFE_RE = /[^A-Za-z0-9._-]/;

/** F1 EV4 + UN4: hook-shaped filenames follow `<event>.<name>.<ext>` with a canonical event. */
function parseHook(file: FileSnapshot): Hook {
  const basename = file.path.slice(file.path.lastIndexOf('/') + 1);
  if (HOOK_BASENAME_UNSAFE_RE.test(basename)) {
    throw new ParseError(
      file.path,
      'hook filenames are restricted to [A-Za-z0-9._-] because they are embedded in ' +
        'provider shell commands',
    );
  }
  const segments = basename.split('.');
  const event = segments[0] ?? '';
  if (!isHookEvent(event)) {
    throw new ParseError(
      file.path,
      `unknown hook event "${event}"; valid events: ${HOOK_EVENTS.join(', ')}`,
    );
  }
  return {
    event,
    // Hook names may contain dots: `pre-tool-use.my.fancy.sh` → `my.fancy`.
    name: segments.slice(1, -1).join('.'),
    path: file.path,
    script: file.content,
  };
}

function recordUnknownAttachment(
  file: FileSnapshot,
  attachments: Attachment[],
  warnings: Warning[],
): void {
  attachments.push({ path: file.path, content: file.content });
  warnings.push({
    code: 'HH-W010',
    severity: 'warn',
    message: `unknown attachment under .agents/: ${file.path}`,
    canonicalPath: file.path,
  });
}

/**
 * B2: Agent Skills standard name shape. Also a security boundary — the name
 * becomes an emit path segment (`.claude/skills/<name>/…`), so path
 * traversal (`../`) and YAML-breaking characters (`:`, quotes) must be
 * rejected, not just frowned upon. Shared with `init` via the entity layer
 * (`SAFE_NAME_RE`) so both code paths enforce the identical boundary.
 */
const SKILL_NAME_RE = SAFE_NAME_RE;

/** F1 EV3 + UN3: skills come from SKILL.md frontmatter; names must be unique. */
function assembleSkills(
  skillFolders: ReadonlyMap<string, FileSnapshot[]>,
  attachments: Attachment[],
  warnings: Warning[],
  parseErrors: ParseError[],
): Skill[] {
  const skills: Skill[] = [];
  const pathByName = new Map<string, string>();
  for (const [folder, folderFiles] of skillFolders) {
    const entry = folderFiles.find((file) => file.path === `${folder}/SKILL.md`);
    if (entry === undefined) {
      // A skill folder without SKILL.md is not a skill; its files are
      // unrecognized `.agents/` content (F1 EV5).
      for (const file of folderFiles) {
        recordUnknownAttachment(file, attachments, warnings);
      }
      continue;
    }
    // #36: a bad SKILL.md is collected, not thrown, so every unparseable file
    // in the repo is reported in ONE pass (the aggregate throws after the
    // walk). A skill that failed here contributes nothing to the IR — the
    // run never proceeds past parse when parseErrors is non-empty.
    try {
      assembleSkill(entry, folderFiles, pathByName, skills);
    } catch (err) {
      if (err instanceof ParseError) {
        parseErrors.push(err);
        continue;
      }
      throw err;
    }
  }
  return skills;
}

function assembleSkill(
  entry: FileSnapshot,
  folderFiles: readonly FileSnapshot[],
  pathByName: Map<string, string>,
  skills: Skill[],
): void {
  const fm = parseFrontmatter(entry.content, entry.path);
  const name = fm.data['name'];
  const description = fm.data['description'];
  if (!fm.present || typeof name !== 'string' || name === '') {
    throw new ParseError(entry.path, 'SKILL.md frontmatter requires a "name" string');
  }
  if (!SKILL_NAME_RE.test(name)) {
    throw new ParseError(
      entry.path,
      `invalid skill name ${JSON.stringify(name)}: names must match ` +
        '^[a-z0-9]+(-[a-z0-9]+)*$ (lowercase alphanumeric segments separated by ' +
        'single hyphens, per the Agent Skills standard)',
    );
  }
  if (typeof description !== 'string' || description === '') {
    throw new ParseError(entry.path, 'SKILL.md frontmatter requires a "description" string');
  }
  const existing = pathByName.get(name);
  if (existing !== undefined) {
    throw new ParseError(
      entry.path,
      `duplicate skill name "${name}" (already defined at ${existing})`,
    );
  }
  pathByName.set(name, entry.path);
  skills.push({
    name,
    description,
    // #38: carry the verbatim frontmatter so the Claude projection reproduces
    // every key (incl. provider-specific `allowed-tools`/`argument-hint`),
    // never silently dropping a tool restriction.
    frontmatter: fm.raw,
    path: entry.path,
    body: fm.body,
    files: folderFiles
      .filter((file) => file !== entry)
      .map((file) => ({ path: file.path, content: file.content })),
  });
}

export async function parseRepo(deps: ParseRepoDeps): Promise<ParseRepoResult> {
  const snapshot = await deps.readRepo();
  // Sorted processing keeps IR ordering and error attribution (which of two
  // duplicate skills is reported "first") deterministic across platforms.
  const files = [...snapshot.files].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  const instructions: Instruction[] = [];
  const hooks: Hook[] = [];
  const attachments: Attachment[] = [];
  const warnings: Warning[] = [];
  const skillFolders = new Map<string, FileSnapshot[]>();

  // #36: per-file ParseErrors are collected (not thrown) so ONE run reports
  // every unparseable file; the aggregate throws after the walk. The run still
  // fails (exit 3) whenever any error was collected — no partial IR ever
  // reaches a projection, which would misclassify the unparsed content's
  // provider files as missing/unmanaged and, at apply time, act on that.
  const parseErrors: ParseError[] = [];
  const collecting = <T>(parse: () => T): T | undefined => {
    try {
      return parse();
    } catch (err) {
      if (err instanceof ParseError) {
        parseErrors.push(err);
        return undefined;
      }
      throw err;
    }
  };

  // EV1 (#21): the gateway reports canonical-shaped paths a .gitignore rule
  // excluded as data (it stays I/O, no Warning-minting in layer 3). The use
  // case mints HH-W012 so `audit`/`apply` surface over-ignored canonical
  // content instead of letting an empty IR drive destructive projections.
  // Scope (PRD §16): no silent loss of canonical sources the walk reaches —
  // a canonical file inside a fully-ignored directory (e.g. `vendor/`) is out
  // of scope by design and not reported (see docs/warnings/HH-W012.md).
  for (const excluded of snapshot.excludedCanonicalPaths ?? []) {
    warnings.push({
      code: 'HH-W012',
      severity: 'warn',
      message:
        `${excluded} is a canonical source but is excluded by a .gitignore rule, ` +
        'so it was not collected. Un-ignore it (e.g. add a "!" negation line) or ' +
        'move the content if the exclusion is intentional.',
      canonicalPath: excluded,
    });
  }

  for (const file of files) {
    const basename = file.path.slice(file.path.lastIndexOf('/') + 1);
    if (basename === 'AGENTS.md' && !file.path.startsWith('.agents/')) {
      instructions.push(parseAgentsMd(file, warnings));
      continue;
    }
    if (!file.path.startsWith('.agents/')) {
      continue;
    }
    // The apply state file (`.agents/.harness-state.json`) is tool bookkeeping,
    // not canonical content — skip it by name so it never becomes an IR
    // attachment (which would otherwise fire HH-W010 and feed itself into
    // projections). `audit` stays independent of it (C2 design note).
    if (file.path === APPLY_STATE_PATH) {
      continue;
    }
    const segments = file.path.split('/');
    if (segments[1] === 'instructions' && segments.length === 3 && file.path.endsWith('.md')) {
      const fragment = collecting(() => parseInstructionFragment(file));
      if (fragment !== undefined) {
        instructions.push(fragment);
      }
    } else if (segments[1] === 'skills' && segments.length >= 4) {
      const folder = segments.slice(0, 3).join('/');
      const folderFiles = skillFolders.get(folder);
      if (folderFiles === undefined) {
        skillFolders.set(folder, [file]);
      } else {
        folderFiles.push(file);
      }
    } else if (segments[1] === 'hooks' && segments.length === 3 && isHookShaped(basename)) {
      const hook = collecting(() => parseHook(file));
      if (hook !== undefined) {
        hooks.push(hook);
      }
    } else {
      recordUnknownAttachment(file, attachments, warnings);
    }
  }

  const skills = assembleSkills(skillFolders, attachments, warnings, parseErrors);

  if (parseErrors.length === 1) {
    throw parseErrors[0];
  }
  if (parseErrors.length > 1) {
    throw new AggregateParseError(parseErrors);
  }

  return { ir: { instructions, skills, hooks, attachments }, warnings };
}
