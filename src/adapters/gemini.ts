/**
 * Google Gemini CLI adapter — A3 (#9).
 *
 * - instructions (default mode 'settings'): write the nested v2 key
 *   `context.fileName: ["AGENTS.md", "GEMINI.md"]` into co-owned
 *   `.gemini/settings.json` (merge-key; no header, PRD §9 carve-out 2)
 *   instead of copying content. Setting it replaces Gemini's hard-coded
 *   default, so "GEMINI.md" is always kept loading. With `gemini.mode:
 *   "shim"` in harness-haircut.config.json, emit `GEMINI.md` `@AGENTS.md`
 *   import shims instead (root + one per nested AGENTS.md, mirroring A2;
 *   Gemini imports resolve with maxDepth 5).
 * - skills: native no-op — `.agents/skills/` is a documented alias that
 *   takes precedence over `.gemini/skills/` (provider matrix, 2026-06-10).
 * - hooks: the `hooks` key in `.gemini/settings.json` (merge-key) using
 *   Gemini's Before/After taxonomy. Gemini timeouts are in MILLISECONDS;
 *   canonical hook metadata carries no timeout yet, so none is emitted —
 *   when the sibling-metadata convention lands (PRD §8) with seconds,
 *   convert s → ms here.
 *
 * Scoped fragments (`.agents/instructions/*.md`) have no Gemini projection
 * target (no rules/paths equivalent) and are not emitted; each one fires
 * HH-W007 (canonical surface unrepresentable) in both settings and shim
 * modes so the gap is never silent.
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
import type { IR, Instruction } from '../entities/ir.js';
import type { Warning } from '../entities/warnings.js';
import { GEMINI_EVENT_MAP } from './event-maps.js';
import { buildMatcherHookGroups, groupHooksByProviderEvent } from './hook-projection.js';
import { readProviderJson } from './provider-json.js';
import { projectImportShim } from './shim.js';

const SETTINGS_PATH = '.gemini/settings.json';

function isAgentsMd(instruction: Instruction): boolean {
  return instruction.path === 'AGENTS.md' || instruction.path.endsWith('/AGENTS.md');
}

function dirOf(path: string): string {
  const slashAt = path.lastIndexOf('/');
  return slashAt === -1 ? '' : path.slice(0, slashAt);
}

/**
 * A3 EV5: merge "AGENTS.md" into an existing `context.fileName` value
 * (string → array promotion, user entries preserved, no duplicates).
 * Without an existing value the default keeps GEMINI.md loading — setting
 * the key replaces Gemini's built-in default. Non-string junk inside an
 * existing array is dropped; a non-string/non-array value is treated as
 * absent.
 */
function mergeContextFileName(settings: Record<string, unknown> | null): string[] {
  const context = settings?.['context'];
  const existing =
    context !== null && typeof context === 'object' && !Array.isArray(context)
      ? (context as Record<string, unknown>)['fileName']
      : undefined;
  let names: string[];
  if (typeof existing === 'string') {
    names = [existing];
  } else if (Array.isArray(existing)) {
    names = existing.filter((value): value is string => typeof value === 'string');
  } else {
    names = ['GEMINI.md'];
  }
  return names.includes('AGENTS.md') ? names : ['AGENTS.md', ...names];
}

export const geminiAdapter: ProviderAdapter = {
  id: 'gemini',

  project(ir: IR, ctx: ProjectionContext): Projection {
    const files: EmittedFile[] = [];
    const warnings: Warning[] = [];
    const reader = ctx.providerFiles;
    const mode = ctx.providerConfig?.['mode'] === 'shim' ? 'shim' : 'settings';

    // Existing settings are read lazily and at most once; the first read
    // also fires UN2 (HH-W006) when the deprecated flat v1 key is present.
    // A malformed file throws MalformedProviderConfigError on first need
    // (UN1) — never consulted, never thrown (e.g. shim mode without hooks).
    // Consequence (intentional): HH-W006 also does not fire in shim mode
    // without hooks — the file is never touched, so its legacy key is moot.
    let settingsLoaded = false;
    let settings: Record<string, unknown> | null = null;
    const loadSettings = (): Record<string, unknown> | null => {
      if (!settingsLoaded) {
        settings = readProviderJson(reader, SETTINGS_PATH);
        settingsLoaded = true;
        if (settings !== null && 'contextFileName' in settings) {
          warnings.push({
            code: 'HH-W006',
            severity: 'warn',
            message:
              `legacy flat "contextFileName" key found in ${SETTINGS_PATH} (deprecated v1 ` +
              'schema); only the nested v2 "context.fileName" key is written — remove the ' +
              'legacy key once nothing depends on it',
            providerId: 'gemini',
          });
        }
      }
      return settings;
    };

    // ---- instructions (EV1 settings mode / EV2 shim mode) ----
    // HH-W007: scoped fragments are unrepresentable for Gemini in BOTH
    // modes — context files have no path-scoping mechanism, so dropping a
    // fragment must never be silent (PRD goal: zero silent data loss).
    const fragments = ir.instructions
      .filter((instruction) => !isAgentsMd(instruction))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    for (const fragmentInstruction of fragments) {
      warnings.push({
        code: 'HH-W007',
        severity: 'warn',
        message:
          `scoped fragment ${fragmentInstruction.path} (scope "${fragmentInstruction.scope}") ` +
          'cannot be projected for Gemini: Gemini context files have no path-scoping ' +
          'mechanism, so the fragment is not emitted for this provider',
        canonicalPath: fragmentInstruction.path,
        providerId: 'gemini',
      });
    }
    const agentsInstructions = ir.instructions.filter(isAgentsMd);
    let instructionsStatus: SurfaceStatus = 'skipped';
    if (mode === 'settings') {
      if (agentsInstructions.length > 0) {
        const fileName = mergeContextFileName(loadSettings());
        files.push({
          path: SETTINGS_PATH,
          body: `${JSON.stringify(fileName, null, 2)}\n`,
          mode: 'merge-key',
          mergeKey: 'context.fileName',
        });
        instructionsStatus = 'merged';
      }
    } else {
      let emitted = 0;
      let mergedCount = 0;
      const sorted = [...agentsInstructions].sort((a, b) =>
        a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
      );
      for (const instruction of sorted) {
        const dir = dirOf(instruction.path);
        const shim = projectImportShim(
          dir === '' ? 'GEMINI.md' : `${dir}/GEMINI.md`,
          reader,
          'gemini',
        );
        if (shim.file !== null) {
          files.push(shim.file);
          emitted += 1;
        } else if (shim.status === 'merged') {
          mergedCount += 1;
        }
        if (shim.warning !== null) {
          warnings.push(shim.warning);
        }
      }
      instructionsStatus = emitted > 0 ? 'emitted' : mergedCount > 0 ? 'merged' : 'skipped';
    }

    // ---- hooks (EV4, OPT1, UN1) ----
    const { byEvent, warnings: hookWarnings } = groupHooksByProviderEvent(
      ir.hooks,
      GEMINI_EVENT_MAP,
      'gemini',
    );
    warnings.push(...hookWarnings);
    let hooksStatus: SurfaceStatus = 'skipped';
    if (byEvent.size > 0) {
      loadSettings();
      const groups = buildMatcherHookGroups(byEvent, (hook) => ({
        type: 'command',
        command: hook.path,
      }));
      files.push({
        path: SETTINGS_PATH,
        body: `${JSON.stringify(groups, null, 2)}\n`,
        mode: 'merge-key',
        mergeKey: 'hooks',
      });
      hooksStatus = 'merged';
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
      const basename = file.path.slice(file.path.lastIndexOf('/') + 1);
      if (basename === 'GEMINI.md') {
        paths.push(file.path);
      }
    }
    if (sorted.some((file) => file.path === SETTINGS_PATH)) {
      paths.push(SETTINGS_PATH);
    }
    return paths.length > 0 ? { providerId: 'gemini', paths } : null;
  },
};
