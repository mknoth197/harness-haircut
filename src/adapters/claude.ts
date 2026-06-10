/**
 * Claude Code adapter — A2 (#8).
 *
 * Claude is the only v1 provider that reads neither `AGENTS.md` nor
 * `.agents/skills/` (provider matrix, 2026-06-10), so every surface
 * projects:
 *
 * - instructions: one-line `@AGENTS.md` import shims (`CLAUDE.md`, root and
 *   one per nested AGENTS.md directory — no header, PRD §9 carve-out 1) and
 *   `.claude/rules/hh.<name>.md` for scoped fragments,
 * - skills: `.claude/skills/<name>/` copies,
 * - hooks: the `hooks` key inside co-owned `.claude/settings.json`
 *   (merge-key; no header, PRD §9 carve-out 2).
 *
 * SignedSource convention for files with frontmatter (`.claude/rules/`,
 * `.claude/skills/<n>/SKILL.md`): Claude needs YAML frontmatter on line 1
 * to parse `paths:` / `name:`, so the header goes on the first line *after*
 * the closing `---` via `embedHeaderAfterFrontmatter`, with BODY_HASH
 * covering frontmatter + body (PRD §9 "Header placement and carve-outs";
 * C1 verifies with `verifyHeaderAfterFrontmatter`).
 *
 * Skill sibling attachments are copied verbatim with NO header: a header
 * would corrupt shebang lines, JSON, and binary-ish assets. Drift detection
 * for them is full-content comparison against canonical (they are fully
 * owned). Provider-specific skill frontmatter extras never reach this
 * adapter — F1 parsing keeps only the Agent Skills common core
 * (name/description), so emitted frontmatter is exactly that core.
 */
import type {
  EmittedFile,
  ExistingProviderConfig,
  Projection,
  ProjectionContext,
  ProviderAdapter,
  RepoSnapshot,
  SurfaceStatus,
} from '../entities/adapter.js';
import { EmitPathCollisionError } from '../entities/errors.js';
import type { IR, Instruction, Skill } from '../entities/ir.js';
import { embedHeaderAfterFrontmatter } from '../entities/signed-source.js';
import type { Warning } from '../entities/warnings.js';
import { CLAUDE_EVENT_MAP } from './event-maps.js';
import { buildMatcherHookGroups, groupHooksByProviderEvent } from './hook-projection.js';
import { readProviderJson } from './provider-json.js';
import { instructionSourceEntry, skillSourceEntry } from './source-manifest.js';
import { projectImportShim } from './shim.js';

function isAgentsMd(instruction: Instruction): boolean {
  return instruction.path === 'AGENTS.md' || instruction.path.endsWith('/AGENTS.md');
}

function dirOf(path: string): string {
  const slashAt = path.lastIndexOf('/');
  return slashAt === -1 ? '' : path.slice(0, slashAt);
}

/** `.agents/instructions/<name>.md` → `<name>`. */
function fragmentName(path: string): string {
  const basename = path.slice(path.lastIndexOf('/') + 1);
  return basename.endsWith('.md') ? basename.slice(0, -3) : basename;
}

/**
 * A2 OPT1 / HH-W001. Claude's `paths:` dialect supports `*`/`**` globs and
 * brace expansion; regex-like syntax (alternation, anchors, escapes) is not
 * a glob and would silently never match, and leading-`!` negation cannot be
 * expressed either. Bare parens/`+` are NOT treated as regex-like — they are
 * legal in real path names (e.g. Next.js `app/(marketing)/`). Downgrade
 * rule: unsupported syntax falls back to `**` (the rule loads for every
 * file) — over-matching keeps the instruction visible, under-matching would
 * lose it.
 */
function claudePathsGlob(instruction: Instruction): { glob: string; warning: Warning | null } {
  if (instruction.scope.startsWith('!')) {
    return {
      glob: '**',
      warning: {
        code: 'HH-W001',
        severity: 'warn',
        message:
          `scope glob "${instruction.scope}" uses negation, which Claude's paths: ` +
          'dialect cannot express; downgraded to "**" (rule loads for every file)',
        canonicalPath: instruction.path,
        providerId: 'claude',
      },
    };
  }
  if (/[|^$\\]/.test(instruction.scope)) {
    return {
      glob: '**',
      warning: {
        code: 'HH-W001',
        severity: 'warn',
        message:
          `scope glob "${instruction.scope}" uses regex-like syntax Claude's paths: ` +
          'dialect cannot express; downgraded to "**" (rule loads for every file)',
        canonicalPath: instruction.path,
        providerId: 'claude',
      },
    };
  }
  return { glob: instruction.scope, warning: null };
}

/**
 * PRD §11 step 2: a lossy downgrade is named inside the emitted file. The
 * comment sits between the frontmatter and the body, so the header inserted
 * by `embedHeaderAfterFrontmatter` lands directly above it and BODY_HASH
 * covers it.
 */
function lossComment(originalGlob: string): string {
  return `<!-- harness-haircut: glob downgraded from ${JSON.stringify(originalGlob)} (HH-W001) -->\n`;
}

function ruleFile(instruction: Instruction, glob: string, downgraded: boolean): EmittedFile {
  const frontmatter = `---\npaths: [${JSON.stringify(glob)}]\n---\n`;
  const loss = downgraded ? lossComment(instruction.scope) : '';
  return {
    path: `.claude/rules/hh.${fragmentName(instruction.path)}.md`,
    body: embedHeaderAfterFrontmatter(frontmatter + loss + instruction.body, [
      instructionSourceEntry(instruction),
    ]),
    mode: 'overwrite',
  };
}

function skillFiles(skill: Skill): EmittedFile[] {
  const frontmatter = `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n`;
  const files: EmittedFile[] = [
    {
      path: `.claude/skills/${skill.name}/SKILL.md`,
      body: embedHeaderAfterFrontmatter(frontmatter + skill.body, [skillSourceEntry(skill)]),
      mode: 'overwrite',
    },
  ];
  // Collision guard for flattened attachment paths (mirrors A4 UN1).
  // Currently unreachable through parseRepo: skill.files only ever contains
  // paths under the skill's own folder, so the basename fallback — the only
  // route to a collision — fires only for hand-constructed IR. Guarded
  // anyway so a future parser change cannot introduce a silent overwrite.
  const sourceByTarget = new Map<string, string>([
    [`.claude/skills/${skill.name}/SKILL.md`, skill.path],
  ]);
  const skillDir = dirOf(skill.path);
  const attachments = [...skill.files].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  for (const attachment of attachments) {
    const relative = attachment.path.startsWith(`${skillDir}/`)
      ? attachment.path.slice(skillDir.length + 1)
      : attachment.path.slice(attachment.path.lastIndexOf('/') + 1);
    const target = `.claude/skills/${skill.name}/${relative}`;
    const existing = sourceByTarget.get(target);
    if (existing !== undefined) {
      throw new EmitPathCollisionError(target, existing, attachment.path);
    }
    sourceByTarget.set(target, attachment.path);
    files.push({ path: target, body: attachment.content, mode: 'overwrite' });
  }
  return files;
}

export const claudeAdapter: ProviderAdapter = {
  id: 'claude',

  project(ir: IR, ctx: ProjectionContext): Projection {
    const files: EmittedFile[] = [];
    const warnings: Warning[] = [];
    const reader = ctx.providerFiles;

    // ---- instructions (EV1 root shim, EV3 nested shims, EV2 rules) ----
    let emitted = 0;
    let merged = 0;
    const sortedInstructions = [...ir.instructions].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
    for (const instruction of sortedInstructions) {
      if (isAgentsMd(instruction)) {
        const dir = dirOf(instruction.path);
        const shim = projectImportShim(
          dir === '' ? 'CLAUDE.md' : `${dir}/CLAUDE.md`,
          reader,
          'claude',
        );
        if (shim.file !== null) {
          files.push(shim.file);
          emitted += 1;
        } else if (shim.status === 'merged') {
          merged += 1;
        }
        if (shim.warning !== null) {
          warnings.push(shim.warning);
        }
      } else {
        const { glob, warning } = claudePathsGlob(instruction);
        if (warning !== null) {
          warnings.push(warning);
        }
        files.push(ruleFile(instruction, glob, warning !== null));
        emitted += 1;
      }
    }
    const instructionsStatus: SurfaceStatus =
      emitted > 0 ? 'emitted' : merged > 0 ? 'merged' : 'skipped';

    // ---- skills (EV4) ----
    const sortedSkills = [...ir.skills].sort((a, b) =>
      a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
    );
    for (const skill of sortedSkills) {
      files.push(...skillFiles(skill));
    }
    const skillsStatus: SurfaceStatus = ir.skills.length > 0 ? 'emitted' : 'skipped';

    // ---- hooks (EV5, UN1) ----
    const { byEvent, warnings: hookWarnings } = groupHooksByProviderEvent(
      ir.hooks,
      CLAUDE_EVENT_MAP,
      'claude',
    );
    warnings.push(...hookWarnings);
    let hooksStatus: SurfaceStatus = 'skipped';
    if (byEvent.size > 0) {
      // UN1: validate before targeting the co-owned file; a malformed
      // settings.json cannot be merged into without risking user content.
      readProviderJson(reader, '.claude/settings.json');
      // Claude docs: project-relative hook commands should be anchored with
      // $CLAUDE_PROJECT_DIR (the session cwd can differ from the repo root).
      // Safe to interpolate: B3 restricts hook basenames to [A-Za-z0-9._-].
      const groups = buildMatcherHookGroups(byEvent, (hook) => ({
        type: 'command',
        command: `$CLAUDE_PROJECT_DIR/${hook.path}`,
      }));
      files.push({
        path: '.claude/settings.json',
        body: `${JSON.stringify(groups, null, 2)}\n`,
        mode: 'merge-key',
        mergeKey: 'hooks',
      });
      hooksStatus = 'merged';
    }

    return {
      files,
      warnings,
      surfaces: { instructions: instructionsStatus, skills: skillsStatus, hooks: hooksStatus },
    };
  },

  detectExisting(snapshot: RepoSnapshot): ExistingProviderConfig | null {
    const sorted = [...snapshot.files].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
    const paths: string[] = [];
    for (const file of sorted) {
      const basename = file.path.slice(file.path.lastIndexOf('/') + 1);
      if (basename === 'CLAUDE.md') {
        paths.push(file.path);
      }
    }
    if (sorted.some((file) => file.path === '.claude/settings.json')) {
      paths.push('.claude/settings.json');
    }
    if (sorted.some((file) => file.path.startsWith('.claude/rules/'))) {
      paths.push('.claude/rules/');
    }
    if (sorted.some((file) => file.path.startsWith('.claude/skills/'))) {
      paths.push('.claude/skills/');
    }
    return paths.length > 0 ? { providerId: 'claude', paths } : null;
  },
};
