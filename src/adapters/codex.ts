/**
 * OpenAI Codex adapter — A1 (#7).
 *
 * Instructions and skills are native no-ops: Codex reads `AGENTS.md`
 * (root→cwd concatenation, 32 KiB combined cap) and discovers
 * `.agents/skills/` directly (provider matrix, 2026-06-10). Hooks are the
 * only projection surface: `.codex/hooks.json`, fully owned (PRD §10).
 *
 * Emitted hook commands reference the canonical script path verbatim and
 * never inline the body — Codex trust-hashes each definition per user and
 * re-prompts the whole team whenever one changes (PRD §14). The optional
 * `timeout` field is omitted: canonical hook metadata carries no timeout
 * yet (PRD §8 reserves a sibling-metadata convention for it).
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
import type { Hook, IR, Instruction } from '../entities/ir.js';
import type { Warning } from '../entities/warnings.js';
import { CODEX_EVENT_MAP } from './event-maps.js';
import { buildMatcherHookGroups, groupHooksByProviderEvent } from './hook-projection.js';

/** Codex's default `project_doc_max_bytes` — the combined AGENTS.md chain cap. */
export const CODEX_PROJECT_DOC_MAX_BYTES = 32 * 1024;

function isAgentsMd(instruction: Instruction): boolean {
  return instruction.path === 'AGENTS.md' || instruction.path.endsWith('/AGENTS.md');
}

/** The directory of an `AGENTS.md` path (`''` for the root file). */
function agentsMdDir(path: string): string {
  const slash = path.lastIndexOf('/');
  return slash === -1 ? '' : path.slice(0, slash);
}

/**
 * True when directory `ancestor` is on the root→`descendant` path — i.e. it is
 * the root (`''`) or an ancestor-or-equal of `descendant`. Codex concatenates,
 * for a given working directory, the root `AGENTS.md` plus every nested
 * `AGENTS.md` from the root down to that directory; sibling/cousin trees are
 * never in the same chain.
 */
function isOnChain(ancestor: string, descendant: string): boolean {
  return ancestor === '' || ancestor === descendant || descendant.startsWith(`${ancestor}/`);
}

/**
 * Codex applies `project_doc_max_bytes` PER root→cwd chain, not across the
 * whole repo. For each AGENTS.md directory (each a candidate cwd), sum the
 * bodies of the AGENTS.md files on its root→cwd chain; return the byte size of
 * the LARGEST such chain (0 when there are no AGENTS.md files). A repo with
 * several large sibling AGENTS.md whose *sum* exceeds the cap but whose every
 * individual chain stays under it must not warn — only a single overweight
 * chain is a real truncation risk.
 */
function maxChainBytes(instructions: readonly Instruction[]): number {
  const agentsMd = instructions.filter(isAgentsMd);
  let max = 0;
  for (const leaf of agentsMd) {
    const leafDir = agentsMdDir(leaf.path);
    let chain = 0;
    for (const candidate of agentsMd) {
      if (isOnChain(agentsMdDir(candidate.path), leafDir)) {
        chain += Buffer.byteLength(candidate.body, 'utf8');
      }
    }
    if (chain > max) {
      max = chain;
    }
  }
  return max;
}

/**
 * Minimal `[hooks]` table detection over the TOML line grammar (zero npm
 * deps): a `[hooks]` / `[ hooks ]` / `["hooks"]` / `[hooks.<sub>]` /
 * `[[hooks…]]` header line outside of full-line comments (TOML allows
 * whitespace inside brackets and quoted keys). Values containing such text
 * on key-value lines are not misdetected because table headers must start
 * the (trimmed) line. Known false positive: a multi-line TOML string
 * containing a line that itself looks like a `[hooks]` header is misdetected
 * — the line grammar cannot track string state; acceptable for a warn-only
 * signal.
 */
function hasHooksTable(toml: string): boolean {
  return toml
    .split('\n')
    .some((line) => /^\[{1,2}\s*(?:"hooks"|'hooks'|hooks)\s*[\].]/.test(line.trim()));
}

function renderHooksJson(byEvent: ReadonlyMap<string, readonly Hook[]>): string {
  const groups = buildMatcherHookGroups(byEvent, (hook) => ({
    type: 'command',
    command: hook.path,
  }));
  return `${JSON.stringify({ hooks: groups }, null, 2)}\n`;
}

export const codexAdapter: ProviderAdapter = {
  id: 'codex',

  project(ir: IR, ctx: ProjectionContext): Projection {
    const files: EmittedFile[] = [];
    const warnings: Warning[] = [];

    // A1 EV1 / HH-W004: Codex silently stops loading AGENTS.md files past the
    // combined cap, applied PER root→cwd chain — the root AGENTS.md plus every
    // nested AGENTS.md from the root down to a given directory. We warn only
    // when some single chain exceeds the cap, not by summing unrelated sibling
    // AGENTS.md (the old whole-repo sum over-counted; #dogfood-round2). Scoped
    // fragments (.agents/instructions/) are not part of the chain and never
    // count.
    const chainBytes = maxChainBytes(ir.instructions);
    if (chainBytes > CODEX_PROJECT_DOC_MAX_BYTES) {
      warnings.push({
        code: 'HH-W004',
        severity: 'warn',
        message:
          `a root→cwd AGENTS.md chain totals ${chainBytes} bytes, over Codex's ` +
          `${CODEX_PROJECT_DOC_MAX_BYTES}-byte project_doc_max_bytes default; ` +
          'Codex silently stops loading files past the cap for that working ' +
          'directory (measured along the deepest root→cwd chain, not by summing ' +
          'sibling AGENTS.md in unrelated subtrees)',
        providerId: 'codex',
      });
    }

    // A1 EV2/EV3 + UN1: project mappable hooks; HH-W003 for the rest.
    const { byEvent, warnings: hookWarnings } = groupHooksByProviderEvent(
      ir.hooks,
      CODEX_EVENT_MAP,
      'codex',
    );
    warnings.push(...hookWarnings);

    let hooksStatus: SurfaceStatus = 'skipped';
    if (byEvent.size > 0) {
      // A1 UN2 / HH-W005: a [hooks] table in .codex/config.toml would be a
      // second active hook source next to the emitted .codex/hooks.json.
      // Only a real double-definition warns — with no hooks to emit there
      // is nothing to duplicate.
      const configToml = ctx.providerFiles?.read('.codex/config.toml');
      if (typeof configToml === 'string' && hasHooksTable(configToml)) {
        warnings.push({
          code: 'HH-W005',
          severity: 'warn',
          message:
            '.codex/config.toml defines a [hooks] table; hooks are also projected ' +
            'to .codex/hooks.json, so both sources would be active at once',
          providerId: 'codex',
        });
      }
      files.push({
        path: '.codex/hooks.json',
        body: renderHooksJson(byEvent),
        mode: 'overwrite',
      });
      hooksStatus = 'emitted';
    }

    return {
      files,
      warnings,
      surfaces: {
        instructions: 'native',
        skills: 'native',
        hooks: hooksStatus,
      },
    };
  },

  // A1 EV4. The snapshot may include provider-owned files (see RepoSnapshot
  // docs); directories are reported as a single trailing-slash marker.
  detectExisting(snapshot: RepoSnapshot): ExistingProviderConfig | null {
    const sorted = [...snapshot.files].sort((a, b) =>
      a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
    );
    const paths: string[] = [];
    for (const file of sorted) {
      const basename = file.path.slice(file.path.lastIndexOf('/') + 1);
      if (basename === 'AGENTS.md' && !file.path.startsWith('.agents/')) {
        paths.push(file.path);
      }
    }
    if (sorted.some((file) => file.path.startsWith('.agents/skills/'))) {
      paths.push('.agents/skills/');
    }
    if (sorted.some((file) => file.path === '.codex/hooks.json')) {
      paths.push('.codex/hooks.json');
    }
    const configToml = sorted.find((file) => file.path === '.codex/config.toml');
    if (configToml !== undefined && hasHooksTable(configToml.content)) {
      paths.push('.codex/config.toml');
    }
    return paths.length > 0 ? { providerId: 'codex', paths } : null;
  },
};
