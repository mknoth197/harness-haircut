/**
 * `init` use case — C3 (#13), PRD §4 (use case 1, onboarding) / §7 / §8.
 * Layer 2: pure orchestration with injected gateways/adapters. It never calls
 * `process.exit`, never touches stdio, never imports `node:fs`/readline —
 * every disk read goes through the injected `ProviderFileReader`, every write
 * through the injected `FileWriter`, the interactive choice through the
 * injected `resolveContradiction`, and the final projection through the
 * injected `apply` (C3 reuses C2 wholesale rather than re-implementing it).
 *
 * Pipeline (U1):
 *   1. detect existing provider files (every adapter's `detectExisting`)
 *   2. UN1: if the repo is already canonical (`.agents/` exists, or root
 *      `AGENTS.md` is itself a generated/projected file), fail (exit 1) and
 *      recommend `apply` — init is for onboarding a NON-canonical repo.
 *   3. build a *candidate* canonical IR by union: recover root-instruction
 *      text from each existing file (EV1 agree → no prompt) and carry skills
 *      over by name.
 *   4. identify contradictions (EV2: a slot whose candidates disagree).
 *   5. resolve them — interactively (EV3) or, under `--non-interactive`, fail
 *      on the first contradiction listing them all (OPT1, exit 1).
 *   6. OPT2 `--dry-run`: report the planned layout and STOP — write nothing,
 *      do not call `apply`.
 *   7. write canonical `AGENTS.md` (+ `.agents/skills/*`), then invoke `apply`
 *      to project everything; report the planned layout + the apply result.
 *
 * Scoped deviations (documented in the C3 PR): provider HOOK configs are not
 * reverse-engineered into canonical hooks (their formats are lossy to invert)
 * — their presence is reported as an informational note, never dropped
 * silently; the interactive resolver is hand-rolled over `node:readline` in
 * layer 4 rather than the `prompts`/`@inquirer/prompts` dependency the story's
 * acceptance line names, to honor the zero-runtime-deps rule (PRD goal 5).
 *
 * Exit codes (PRD §7; choices documented inline):
 *   0  success — canonical layout written and projected (or dry-run preview)
 *   1  refused: already-canonical (UN1), or an unresolved contradiction under
 *      `--non-interactive` (OPT1)
 *   (apply's own exit code is surfaced when it is non-zero)
 */
import type {
  ProviderAdapter,
  ProviderFileReader,
  ProviderId,
  RepoSnapshot,
} from '../entities/adapter.js';
import type { Attachment } from '../entities/ir.js';
import type { ApplyReport } from './apply.js';
import type {
  CandidateText,
  Contradiction,
  ContradictionResolver,
  Resolution,
} from '../entities/contradiction.js';
import type { FileWriter } from '../entities/file-writer.js';
import {
  normalizeForCompare,
  recoverFromAgentsMd,
  recoverFromCopilotInstructions,
  recoverFromShim,
} from '../entities/instruction-source.js';
import { detectHeaderPlacement } from '../entities/signed-source.js';

export interface InitFlags {
  /** OPT2: compute the planned layout but write nothing and do not call apply. */
  dryRun: boolean;
  /** OPT1: never prompt — any contradiction fails the run (exit 1). */
  nonInteractive: boolean;
}

/** A skill recovered from an existing provider skills directory. */
interface DiscoveredSkill {
  name: string;
  /** Repo-relative path of the source SKILL.md. */
  path: string;
  providerId: ProviderId;
  /** Full SKILL.md text (frontmatter + body), written verbatim into canonical. */
  content: string;
  /** Sibling files alongside SKILL.md, carried verbatim. */
  files: Attachment[];
}

/** One file the planned canonical layout will (or would) create. */
export interface PlannedFile {
  /** Repo-relative POSIX path under the canonical layout. */
  path: string;
  /** Where the content came from (which provider/slot won). */
  origin: string;
}

export interface InitReport {
  /** PRD §7: 0 success · 1 refused (already-canonical / unresolved). */
  exitCode: 0 | 1;
  /** Set when the run refused before doing any work. */
  refused?: 'already-canonical' | 'unresolved-contradictions';
  /** True when this was a `--dry-run` (no writes, apply not called). */
  dryRun: boolean;
  /** Existing provider configs detected, in adapter order. */
  detected: { providerId: ProviderId; paths: string[] }[];
  /** Contradictions surfaced (resolved interactively, or listed on OPT1 fail). */
  contradictions: Contradiction[];
  /** Canonical files init wrote (or, on dry-run, would write). */
  planned: PlannedFile[];
  /**
   * Informational, non-fatal notes (PRD goal 3: zero silent data loss). The
   * carried-over-hooks scope deviation lands here rather than as a warning
   * code — it is advice, not a lossy translation.
   */
  notes: string[];
  /** The `apply` result, when init proceeded to project (absent on refuse/dry-run). */
  apply?: ApplyReport;
}

export interface InitDeps {
  /**
   * Wide repo snapshot: canonical sources PLUS provider-owned instruction and
   * skill files, so `detectExisting` and candidate recovery see everything.
   */
  snapshot: () => Promise<RepoSnapshot>;
  /** Read-only disk access for recovering candidate file contents. */
  reader: ProviderFileReader;
  /** The single mutation surface — canonical `AGENTS.md` + skills are written here. */
  writer: FileWriter;
  /** Enabled adapters (already filtered by config) — used only for `detectExisting`. */
  adapters: readonly ProviderAdapter[];
  /** EV2/EV3: layer 4's numbered-choice prompt (readline), or a non-interactive stub. */
  resolveContradiction: ContradictionResolver;
  /** C3 reuses C2: the fully-wired `apply` the composition root supplies. */
  apply: () => Promise<ApplyReport>;
  flags: InitFlags;
}

/** Repo-relative root instruction files, in the order candidates are gathered. */
const ROOT_INSTRUCTION_SOURCES: { path: string; providerId: ProviderId; recover: (c: string) => string }[] = [
  { path: 'AGENTS.md', providerId: 'codex', recover: recoverFromAgentsMd },
  { path: 'CLAUDE.md', providerId: 'claude', recover: recoverFromShim },
  { path: 'GEMINI.md', providerId: 'gemini', recover: recoverFromShim },
  {
    path: '.github/copilot-instructions.md',
    providerId: 'copilot',
    recover: recoverFromCopilotInstructions,
  },
];

/** Skill source roots, highest precedence first (canonical, then current, then legacy). */
const SKILL_SOURCE_ROOTS: { prefix: string; providerId: ProviderId }[] = [
  { prefix: '.agents/skills/', providerId: 'codex' },
  { prefix: '.claude/skills/', providerId: 'claude' },
  { prefix: '.codex/skills/', providerId: 'codex' },
];

function byPath(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function byProvider(a: CandidateText, b: CandidateText): number {
  return a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0;
}

/**
 * UN1 — already-canonical fast-fail trigger. The repo is "already onboarded"
 * when EITHER a `.agents/` directory exists (the canonical home), OR a root
 * `AGENTS.md` exists AND is itself a generated/projected file (carries a
 * SignedSource header — it was emitted by `apply`, not hand-authored). A
 * plain hand-written root `AGENTS.md` with NO `.agents/` is exactly the
 * drifted repo init is meant to onboard, so it does NOT trip UN1.
 */
function isAlreadyCanonical(snapshot: RepoSnapshot, reader: ProviderFileReader): boolean {
  const hasAgentsDir = snapshot.files.some((file) => file.path.startsWith('.agents/'));
  if (hasAgentsDir) {
    return true;
  }
  const rootAgents = reader.read('AGENTS.md');
  return rootAgents !== null && detectHeaderPlacement(rootAgents) !== 'none';
}

/** Gathers candidate root-instruction texts from each existing provider file. */
function gatherRootCandidates(reader: ProviderFileReader): CandidateText[] {
  const candidates: CandidateText[] = [];
  for (const source of ROOT_INSTRUCTION_SOURCES) {
    const raw = reader.read(source.path);
    if (raw === null) {
      continue;
    }
    const text = source.recover(raw);
    // A shim with no user content below the import (or an emptied file) carries
    // no candidate — skip it rather than offering an empty choice.
    if (text.trim() === '') {
      continue;
    }
    candidates.push({
      providerId: source.providerId,
      path: source.path,
      text,
      normalizedText: normalizeForCompare(text),
    });
  }
  return candidates.sort(byProvider);
}

/** `.../<name>/SKILL.md` → `<name>`; null when the path is not a SKILL.md entry. */
function skillNameFromPath(path: string, prefix: string): string | null {
  if (!path.startsWith(prefix) || !path.endsWith('/SKILL.md')) {
    return null;
  }
  const rest = path.slice(prefix.length, -'/SKILL.md'.length);
  return rest.includes('/') || rest === '' ? null : rest;
}

/**
 * Discovers skills across the provider skill roots, keyed by name. The first
 * root to define a name wins as the canonical content; same-name skills from a
 * later root are recorded so the caller can detect a body conflict.
 */
function discoverSkills(snapshot: RepoSnapshot): Map<string, DiscoveredSkill[]> {
  const byName = new Map<string, DiscoveredSkill[]>();
  const sorted = [...snapshot.files].sort(byPath);
  for (const root of SKILL_SOURCE_ROOTS) {
    for (const file of sorted) {
      const name = skillNameFromPath(file.path, root.prefix);
      if (name === null) {
        continue;
      }
      const folder = `${root.prefix}${name}`;
      const files = sorted
        .filter((sibling) => sibling.path.startsWith(`${folder}/`) && sibling.path !== file.path)
        .map((sibling) => ({
          path: sibling.path.slice(folder.length + 1),
          content: sibling.content,
        }));
      const discovered: DiscoveredSkill = {
        name,
        path: file.path,
        providerId: root.providerId,
        content: file.content,
        files,
      };
      const existing = byName.get(name);
      if (existing === undefined) {
        byName.set(name, [discovered]);
      } else {
        existing.push(discovered);
      }
    }
  }
  return byName;
}

/** True when every candidate's normalized text is byte-identical (EV1). */
function allAgree(candidates: CandidateText[]): boolean {
  if (candidates.length === 0) {
    return true;
  }
  const first = candidates[0]!.normalizedText;
  return candidates.every((candidate) => candidate.normalizedText === first);
}

/** Applies a resolution to a candidate list → chosen text, or null for skip/empty. */
function chosenText(candidates: CandidateText[], resolution: Resolution): string | null {
  if (resolution.kind === 'choose') {
    return candidates[resolution.index]?.text ?? null;
  }
  return null;
}

export async function init(deps: InitDeps): Promise<InitReport> {
  const { flags } = deps;
  const snapshot = await deps.snapshot();

  // ---- step 1: detect existing provider files ----
  const detected = deps.adapters
    .map((adapter) => adapter.detectExisting(snapshot))
    .filter((config): config is NonNullable<typeof config> => config !== null)
    .map((config) => ({ providerId: config.providerId, paths: config.paths }));

  // ---- step 2: UN1 already-canonical fast-fail ----
  if (isAlreadyCanonical(snapshot, deps.reader)) {
    return {
      exitCode: 1,
      refused: 'already-canonical',
      dryRun: flags.dryRun,
      detected,
      contradictions: [],
      planned: [],
      notes: [
        'this repo already has canonical artifacts (a .agents/ directory or a ' +
          'generated root AGENTS.md). init onboards a non-canonical repo — run ' +
          '`harness-haircut apply` to refresh projections instead.',
      ],
    };
  }

  // ---- step 3: build candidate canonical IR by union ----
  const rootCandidates = gatherRootCandidates(deps.reader);
  const skillsByName = discoverSkills(snapshot);

  // ---- step 4: identify contradictions (EV1 agree → none; EV2 disagree) ----
  const contradictions: Contradiction[] = [];
  if (rootCandidates.length > 0 && !allAgree(rootCandidates)) {
    contradictions.push({ slot: 'root-instructions', candidates: rootCandidates, plusSkip: true });
  }
  const skillContradictions = new Map<string, Contradiction>();
  for (const [name, discovered] of [...skillsByName].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (discovered.length < 2) {
      continue;
    }
    const candidates: CandidateText[] = discovered
      .map((skill) => ({
        providerId: skill.providerId,
        path: skill.path,
        text: skill.content,
        normalizedText: normalizeForCompare(skill.content),
      }))
      .sort(byProvider);
    if (!allAgree(candidates)) {
      const contradiction: Contradiction = {
        slot: `skill:${name}`,
        candidates,
        plusSkip: true,
      };
      contradictions.push(contradiction);
      skillContradictions.set(name, contradiction);
    }
  }

  // ---- step 5: OPT1 non-interactive fails on any contradiction ----
  if (flags.nonInteractive && contradictions.length > 0) {
    return {
      exitCode: 1,
      refused: 'unresolved-contradictions',
      dryRun: flags.dryRun,
      detected,
      contradictions,
      planned: [],
      notes: [
        `--non-interactive cannot resolve ${contradictions.length} contradiction(s); ` +
          're-run interactively or reconcile the listed files by hand.',
      ],
    };
  }

  // ---- step 5 (cont.): resolve contradictions interactively (EV3) ----
  const resolutionBySlot = new Map<string, Resolution>();
  for (const contradiction of contradictions) {
    const resolution = await deps.resolveContradiction(contradiction);
    if (resolution.kind === 'unresolved') {
      // A resolver that gives up mid-stream (e.g. EOF on stdin) is the OPT1
      // failure mode even outside --non-interactive: nothing is written.
      return {
        exitCode: 1,
        refused: 'unresolved-contradictions',
        dryRun: flags.dryRun,
        detected,
        contradictions,
        planned: [],
        notes: [`contradiction "${contradiction.slot}" was left unresolved; nothing was written.`],
      };
    }
    resolutionBySlot.set(contradiction.slot, resolution);
  }

  // ---- decide the canonical root AGENTS.md text ----
  let rootText: string | null = null;
  let rootOrigin = '';
  if (rootCandidates.length > 0) {
    const rootContradiction = contradictions.find((c) => c.slot === 'root-instructions');
    if (rootContradiction === undefined) {
      // EV1: all candidates agree → use the (shared) text, no prompt.
      rootText = rootCandidates[0]!.text;
      rootOrigin = `agreed (${rootCandidates.map((c) => c.providerId).join(', ')})`;
    } else {
      const resolution = resolutionBySlot.get('root-instructions')!;
      rootText = chosenText(rootCandidates, resolution);
      rootOrigin =
        resolution.kind === 'choose'
          ? `chose ${rootCandidates[resolution.index]?.providerId ?? '?'} (${rootCandidates[resolution.index]?.path ?? '?'})`
          : 'skipped';
    }
  }

  // ---- decide the canonical skills ----
  const plannedSkillWrites: { path: string; content: string; origin: string }[] = [];
  for (const [name, discovered] of [...skillsByName].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const contradiction = skillContradictions.get(name);
    let chosen: DiscoveredSkill | null;
    let origin: string;
    if (contradiction === undefined) {
      // EV1: identical (or single) → carry the first/only copy.
      chosen = discovered[0]!;
      origin =
        discovered.length > 1
          ? `agreed (${discovered.map((s) => s.providerId).join(', ')})`
          : chosen.providerId;
    } else {
      const resolution = resolutionBySlot.get(`skill:${name}`)!;
      chosen = resolution.kind === 'choose' ? discovered[resolution.index] ?? null : null;
      origin = resolution.kind === 'choose' ? `chose ${chosen?.providerId ?? '?'}` : 'skipped';
    }
    if (chosen === null) {
      continue;
    }
    plannedSkillWrites.push({
      path: `.agents/skills/${name}/SKILL.md`,
      content: chosen.content,
      origin,
    });
    for (const sibling of chosen.files) {
      plannedSkillWrites.push({
        path: `.agents/skills/${name}/${sibling.path}`,
        content: sibling.content,
        origin,
      });
    }
  }

  // ---- assemble the planned layout ----
  const planned: PlannedFile[] = [];
  if (rootText !== null) {
    planned.push({ path: 'AGENTS.md', origin: rootOrigin });
  }
  for (const write of plannedSkillWrites) {
    planned.push({ path: write.path, origin: write.origin });
  }

  // ---- carried-over hooks note (scoped deviation: not reverse-engineered) ----
  const notes = hookNotes(detected);

  // ---- step 6: OPT2 dry-run stops here ----
  if (flags.dryRun) {
    return {
      exitCode: 0,
      dryRun: true,
      detected,
      contradictions,
      planned,
      notes,
    };
  }

  // ---- step 7: write canonical layout, then project via injected apply ----
  if (rootText !== null) {
    deps.writer.write('AGENTS.md', rootText);
  }
  for (const write of plannedSkillWrites) {
    deps.writer.write(write.path, write.content);
  }

  const applyReport = await deps.apply();

  return {
    exitCode: applyReport.exitCode === 0 ? 0 : 1,
    dryRun: false,
    detected,
    contradictions,
    planned,
    notes,
    apply: applyReport,
  };
}

/**
 * Builds the informational notes for provider hook configs that init detected
 * but did NOT reverse-engineer (scoped v1 deviation). Inverting a provider's
 * hook config back into a canonical hook is lossy/ambiguous, so existing hook
 * configs are left in place and the user is told to author canonical hooks
 * under `.agents/hooks/` and re-run apply.
 */
function hookNotes(detected: { providerId: ProviderId; paths: string[] }[]): string[] {
  const HOOK_PATHS: { match: (p: string) => boolean; label: string }[] = [
    { match: (p) => p === '.claude/settings.json', label: '.claude/settings.json' },
    { match: (p) => p === '.codex/hooks.json', label: '.codex/hooks.json' },
    { match: (p) => p === '.codex/config.toml', label: '.codex/config.toml' },
    { match: (p) => p === '.gemini/settings.json', label: '.gemini/settings.json' },
    { match: (p) => p.startsWith('.github/hooks/'), label: '.github/hooks/' },
  ];
  const found = new Set<string>();
  for (const config of detected) {
    for (const path of config.paths) {
      for (const hookPath of HOOK_PATHS) {
        if (hookPath.match(path)) {
          found.add(hookPath.label);
        }
      }
    }
  }
  if (found.size === 0) {
    return [];
  }
  return [
    `existing hook configuration in ${[...found].sort().join(', ')} was left in place; ` +
      'harness-haircut does not reverse-engineer provider hooks into canonical hooks in v1. ' +
      'Author canonical hooks under .agents/hooks/ and re-run `harness-haircut apply`.',
  ];
}
