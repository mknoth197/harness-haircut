/**
 * GitHub Copilot adapter — A4 (#10).
 *
 * Copilot's instruction surface is split by product surface: the coding/
 * cloud agent, CLI, and VS Code read AGENTS.md natively (root + nested),
 * but **code review does not** (provider matrix, 2026-06-10). The adapter
 * therefore emits the legacy review-covering files anyway:
 *
 * - root instruction → `.github/copilot-instructions.md` (overwrite,
 *   SignedSource header on line 1, then an HTML comment explaining the
 *   file exists for code review and AGENTS.md is authoritative),
 * - scoped fragments → `.github/instructions/hh.<name>.instructions.md`
 *   with `applyTo:` frontmatter (header after the frontmatter via
 *   `embedHeaderAfterFrontmatter` — PRD §9 "Header placement and
 *   carve-outs", same convention as A2),
 * - nested AGENTS.md → `.github/instructions/hh.nested-<dir-with-dashes>
 *   .instructions.md` with `applyTo: "<dir>/**"` so review still sees
 *   nested content (EV2b); other surfaces read nested AGENTS.md natively
 *   and tolerate the duplication per the documented precedence rules.
 *
 * Skills are a native no-op (`.agents/skills/` searched since 2025-12-18).
 * Hooks go to fully-owned `.github/hooks/harness-haircut.json` pinned to
 * the conservative cross-surface entry schema
 * `{type: "command", bash, powershell}` (PRD §14 risk 3). JSON carries no
 * comments, so this owned file takes NO SignedSource header (PRD §9
 * carve-out — drift detection falls back to full-content comparison) and the
 * two operational caveats below are exported as `COPILOT_HOOK_NOTES` for
 * the C-series to surface (the adapter is pure and cannot see the current
 * git branch, so A4 UN2's "non-default branch" note is emitted by the
 * composition root, not here).
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
import type { IR, Instruction } from '../entities/ir.js';
import { embedHeader, embedHeaderAfterFrontmatter } from '../entities/signed-source.js';
import type { Warning } from '../entities/warnings.js';
import { COPILOT_EVENT_MAP } from './event-maps.js';
import { groupHooksByProviderEvent } from './hook-projection.js';
import { instructionSourceEntry } from './source-manifest.js';

export const COPILOT_HOOKS_PATH = '.github/hooks/harness-haircut.json';

/**
 * Operational caveats for emitted Copilot hooks (A4 UN2 + OPT2). The hooks
 * file is JSON and cannot carry comments, so the C-series commands surface
 * these informationally (no warning code).
 */
export const COPILOT_HOOK_NOTES = {
  defaultBranchOnly:
    'the Copilot cloud agent only honors .github/hooks/*.json from the repository ' +
    'default branch — hooks emitted on another branch take effect after merge',
  preToolUseFailClosed:
    'preToolUse hooks are fail-closed on the Copilot cloud agent: a timeout or crash ' +
    'denies the tool call, so keep hook scripts fast (<5s)',
} as const;

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

/** Single-level brace expansion: `a{b,c}d` → `abd`, `acd` (recurses left to right). */
function expandBraces(glob: string): string[] {
  const open = glob.indexOf('{');
  if (open === -1) {
    return [glob];
  }
  const close = glob.indexOf('}', open);
  if (close === -1) {
    return [glob];
  }
  const prefix = glob.slice(0, open);
  const suffix = glob.slice(close + 1);
  return glob
    .slice(open + 1, close)
    .split(',')
    .flatMap((alternative) => expandBraces(prefix + alternative.trim() + suffix));
}

/**
 * Nested braces (a `{` opening before the matching `}` of an already-open
 * brace) defeat `expandBraces`' naive first-`}` matching — the expansion
 * would be broken, so the whole glob is downgraded instead.
 */
function hasNestedBraces(glob: string): boolean {
  let depth = 0;
  for (const char of glob) {
    if (char === '{') {
      depth += 1;
      if (depth > 1) {
        return true;
      }
    } else if (char === '}') {
      depth = Math.max(0, depth - 1);
    }
  }
  return false;
}

/**
 * A4 OPT1 / HH-W001. Copilot's documented `applyTo` dialect supports
 * comma-separated `*`/`**` globs — no negation, no braces. Downgrade rules:
 * - leading `!` (negation): inverting cannot be expressed; fall back to
 *   `**` (the instruction applies everywhere — over-matching keeps it
 *   visible, silently dropping it would lose content),
 * - nested braces: cannot be expanded faithfully; fall back to `**` rather
 *   than emitting a broken expansion,
 * - single-level brace expansion: expand into the equivalent
 *   comma-separated glob list (closest expressible form; still warned per
 *   the story).
 */
function copilotApplyTo(instruction: Instruction): { globs: string[]; warning: Warning | null } {
  const scope = instruction.scope;
  if (scope.startsWith('!')) {
    return {
      globs: ['**'],
      warning: {
        code: 'HH-W001',
        severity: 'warn',
        message:
          `scope glob "${scope}" uses negation, which Copilot's applyTo dialect cannot ` +
          'express; downgraded to "**" (instructions apply to every file)',
        canonicalPath: instruction.path,
        providerId: 'copilot',
      },
    };
  }
  if (hasNestedBraces(scope)) {
    return {
      globs: ['**'],
      warning: {
        code: 'HH-W001',
        severity: 'warn',
        message:
          `scope glob "${scope}" uses nested brace expansion, which cannot be expanded ` +
          'faithfully for Copilot\'s applyTo dialect; downgraded to "**" (instructions ' +
          'apply to every file)',
        canonicalPath: instruction.path,
        providerId: 'copilot',
      },
    };
  }
  if (scope.includes('{')) {
    const globs = expandBraces(scope);
    return {
      globs,
      warning: {
        code: 'HH-W001',
        severity: 'warn',
        message:
          `scope glob "${scope}" uses brace expansion, which Copilot's applyTo dialect ` +
          `does not document; expanded to "${globs.join(', ')}"`,
        canonicalPath: instruction.path,
        providerId: 'copilot',
      },
    };
  }
  return { globs: [scope], warning: null };
}

/** PRD §11 step 2: a lossy downgrade is named inside the emitted file (see A2's twin). */
function lossComment(originalGlob: string): string {
  return `<!-- harness-haircut: glob downgraded from ${JSON.stringify(originalGlob)} (HH-W001) -->\n`;
}

function instructionsFile(
  targetPath: string,
  applyToGlobs: string[],
  instruction: Instruction,
  downgraded = false,
): EmittedFile {
  // No space after the comma: Copilot's applyTo examples are not documented
  // to tolerate whitespace between comma-separated globs (B4).
  const frontmatter = `---\napplyTo: ${JSON.stringify(applyToGlobs.join(','))}\n---\n`;
  const loss = downgraded ? lossComment(instruction.scope) : '';
  return {
    path: targetPath,
    body: embedHeaderAfterFrontmatter(frontmatter + loss + instruction.body, [
      instructionSourceEntry(instruction),
    ]),
    mode: 'overwrite',
  };
}

const REVIEW_NOTE =
  '<!-- This file exists for Copilot code review, which does not read AGENTS.md. ' +
  'AGENTS.md is the authoritative source — edit it and re-run harness-haircut apply. -->';

export const copilotAdapter: ProviderAdapter = {
  id: 'copilot',

  project(ir: IR, ctx: ProjectionContext): Projection {
    void ctx;
    const files: EmittedFile[] = [];
    const warnings: Warning[] = [];

    // ---- instructions (EV1 root, EV2 fragments, EV2b nested, UN1) ----
    // UN1: track target paths so two sources flattening to one filename
    // fail before emit, naming both.
    const sourceByTarget = new Map<string, string>();
    const claim = (targetPath: string, sourcePath: string): void => {
      const existing = sourceByTarget.get(targetPath);
      if (existing !== undefined) {
        throw new EmitPathCollisionError(targetPath, existing, sourcePath);
      }
      sourceByTarget.set(targetPath, sourcePath);
    };

    const sortedInstructions = [...ir.instructions].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
    for (const instruction of sortedInstructions) {
      if (instruction.path === 'AGENTS.md') {
        const target = '.github/copilot-instructions.md';
        claim(target, instruction.path);
        const body = `${REVIEW_NOTE}\n\n${instruction.body}`;
        files.push({
          path: target,
          body: embedHeader(body, [instructionSourceEntry(instruction)], 'html'),
          mode: 'overwrite',
        });
      } else if (isAgentsMd(instruction)) {
        const dir = dirOf(instruction.path);
        const target = `.github/instructions/hh.nested-${dir.replaceAll('/', '-')}.instructions.md`;
        claim(target, instruction.path);
        files.push(instructionsFile(target, [`${dir}/**`], instruction));
      } else {
        const target = `.github/instructions/hh.${fragmentName(instruction.path)}.instructions.md`;
        claim(target, instruction.path);
        const { globs, warning } = copilotApplyTo(instruction);
        if (warning !== null) {
          warnings.push(warning);
        }
        files.push(instructionsFile(target, globs, instruction, warning !== null));
      }
    }
    const instructionsStatus: SurfaceStatus = ir.instructions.length > 0 ? 'emitted' : 'skipped';

    // ---- hooks (EV4, OPT2) ----
    const { byEvent, warnings: hookWarnings } = groupHooksByProviderEvent(
      ir.hooks,
      COPILOT_EVENT_MAP,
      'copilot',
    );
    warnings.push(...hookWarnings);
    let hooksStatus: SurfaceStatus = 'skipped';
    if (byEvent.size > 0) {
      // Conservative cross-surface entry schema; both platform commands
      // reference the canonical script path verbatim (stable, like A1) —
      // whether it runs on Windows depends on the script itself.
      const events: Record<string, unknown> = {};
      for (const [event, eventHooks] of byEvent) {
        events[event] = eventHooks.map((hook) => ({
          type: 'command',
          bash: hook.path,
          powershell: hook.path,
        }));
      }
      files.push({
        path: COPILOT_HOOKS_PATH,
        body: `${JSON.stringify({ version: 1, hooks: events }, null, 2)}\n`,
        mode: 'overwrite',
      });
      hooksStatus = 'emitted';
    }

    return {
      files,
      warnings,
      surfaces: { instructions: instructionsStatus, skills: 'native', hooks: hooksStatus },
    };
  },

  detectExisting(snapshot: RepoSnapshot): ExistingProviderConfig | null {
    const sorted = [...snapshot.files].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
    const paths: string[] = [];
    for (const file of sorted) {
      if (
        file.path === '.github/copilot-instructions.md' ||
        (file.path.startsWith('.github/instructions/') && file.path.endsWith('.instructions.md')) ||
        (file.path.startsWith('.github/hooks/') && file.path.endsWith('.json'))
      ) {
        paths.push(file.path);
      }
    }
    return paths.length > 0 ? { providerId: 'copilot', paths } : null;
  },
};
