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
 *   2. UN1 (revised by C6 #44): if the repo is TOOL-canonical (a
 *      `.agents/.harness-state.json` state file, or a generated/projected root
 *      `AGENTS.md`), fail (exit 1) and recommend `apply`. If it has a HAND-BUILT
 *      `.agents/` tree (canonical-shaped but no tool markers) and `--adopt` is
 *      not set, fail (exit 1) and recommend `init --adopt`. Under `--adopt` the
 *      hand-built tree is adopted as the highest-precedence canonical content.
 *   3. build a *candidate* canonical IR by union: recover root-instruction
 *      text from each existing file (EV1 agree → no prompt), recover per-file
 *      SCOPED instruction fragments (`.github/instructions/*.instructions.md`
 *      via `applyTo:`, `.claude/rules/*.md` via `paths:`) into canonical
 *      `.agents/instructions/<name>.md`, and carry skills over by name.
 *   4. identify contradictions (EV2: a slot whose candidates disagree —
 *      `root-instructions`, `skill:<name>`, or `fragment:<name>`).
 *   5. resolve them — interactively (EV3) or, under `--non-interactive`, fail
 *      on the first contradiction listing them all (OPT1, exit 1).
 *   6. OPT2 `--dry-run`: report the planned layout and STOP — write nothing,
 *      do not call `apply`.
 *   7. before projecting: back up every NON-chosen contradiction candidate's
 *      original text to `.harness-haircut-init-backup/<sanitized-path>` (F2,
 *      no silent loss), then write canonical `AGENTS.md`, the recovered
 *      `.agents/instructions/*` fragments, and `.agents/skills/*`, then invoke
 *      `apply` to project everything; report the planned layout + apply result.
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
 *   1  refused: tool-canonical (UN1, → apply), hand-built canonical without
 *      `--adopt` (C6, → init --adopt), or an unresolved contradiction under
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
import { isSafeName } from '../entities/ir.js';
import { APPLY_STATE_PATH } from '../entities/apply-state.js';
import type { ApplyReport } from './apply.js';
import type {
  CandidateText,
  Contradiction,
  ContradictionResolver,
  Resolution,
} from '../entities/contradiction.js';
import type { FileWriter } from '../entities/file-writer.js';
import {
  fragmentNameFromSource,
  normalizeForCompare,
  recoverFragmentFromCanonical,
  recoverFragmentFromClaudeRule,
  recoverFragmentFromCopilot,
  recoverFromAgentsMd,
  recoverFromCopilotInstructions,
  recoverFromShim,
  type RecoveredFragment,
} from '../entities/instruction-source.js';
import { detectHeaderPlacement } from '../entities/signed-source.js';

export interface InitFlags {
  /** OPT2: compute the planned layout but write nothing and do not call apply. */
  dryRun: boolean;
  /** OPT1: never prompt — any contradiction fails the run (exit 1). */
  nonInteractive: boolean;
  /**
   * AD3 (#44, C6): adopt a HAND-BUILT canonical repo. Bypasses the
   * already-canonical refusal ONLY for a repo whose `.agents/` tree was created
   * by hand (no harness-haircut state file, no SignedSource'd root `AGENTS.md`),
   * treating that tree as the highest-precedence canonical content. Has no
   * effect on a tool-canonical repo (AD1 still refuses → `apply`) or a
   * non-canonical repo (AD8 — behaves as plain `init`).
   */
  adopt: boolean;
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
  /**
   * Set when the run refused before doing any work. `hand-canonical-needs-adopt`
   * (C6 #44) is the hand-built `.agents/` case: distinct from `already-canonical`
   * because the recommended remedy is `init --adopt`, not `apply`.
   */
  refused?:
    | 'already-canonical'
    | 'hand-canonical-needs-adopt'
    | 'unresolved-contradictions'
    | 'symlinked-canonical-home';
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
  /**
   * F2 (no silent loss): repo-relative paths of the backup files init wrote for
   * non-chosen contradiction candidates (under `.harness-haircut-init-backup/`).
   * Empty on `--dry-run` (backups are skipped there) and when nothing was
   * displaced. `--json` surfaces this so the recovery location is machine-readable.
   */
  backups: string[];
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
  /**
   * #35: resolves a path that traverses an in-repo symlinked parent to its
   * real location (or null). Used to refuse a SYMLINKED `.agents/` before any
   * write: the walk skips symlinks (canonical content there would be
   * invisible to every later parse) and the writer refuses symlinked-parent
   * traversal — without this check init would crash mid-onboarding (exit 70)
   * on its first canonical write, after backups were already written.
   */
  aliasOf?: (path: string) => string | null;
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

/**
 * F1 — scoped instruction fragment source roots, HIGHEST precedence first.
 * Each provider stores per-file scoped instructions in its own directory and
 * frontmatter dialect; `recover` parses that dialect (canonical `scope:`,
 * Copilot `applyTo:`, Claude `paths:`) into a canonical `{ scope, body }`, or
 * returns `null` when the file carries no scope to derive (surfaced as a note,
 * never dropped).
 *
 * C6 (#44): `.agents/instructions/` (the canonical home itself) leads the list
 * so that under `--adopt` a hand-built canonical fragment is the top-precedence
 * candidate for its slot — a same-named provider fragment then becomes a proper
 * `fragment:<name>` contradiction (AD4) rather than silently overwriting it.
 * Its `providerId` is labelled `codex` to match the existing
 * `SKILL_SOURCE_ROOTS` convention for the canonical `.agents/` tree (Codex's
 * native format IS the canonical shape; there is no distinct `canonical`
 * `ProviderId` in v1). In a NON-adopt onboarding run `.agents/` does not exist,
 * so this root contributes nothing and the F1 behaviour is unchanged.
 */
const FRAGMENT_SOURCE_ROOTS: {
  prefix: string;
  providerId: ProviderId;
  matches: (path: string) => boolean;
  recover: (content: string) => RecoveredFragment | null;
}[] = [
  {
    prefix: '.agents/instructions/',
    providerId: 'codex',
    // Direct `.agents/instructions/<name>.md` children only (the canonical
    // fragment shape); never the state file or a nested subtree.
    matches: (path) =>
      path.startsWith('.agents/instructions/') &&
      path.endsWith('.md') &&
      !path.slice('.agents/instructions/'.length).includes('/'),
    recover: recoverFragmentFromCanonical,
  },
  {
    prefix: '.github/instructions/',
    providerId: 'copilot',
    // Skip the nested-AGENTS.md projection (`hh.nested-*`): its canonical home
    // is a nested AGENTS.md, not a `.agents/instructions/` fragment.
    matches: (path) =>
      path.startsWith('.github/instructions/') &&
      path.endsWith('.instructions.md') &&
      !path.slice('.github/instructions/'.length).startsWith('hh.nested-'),
    recover: recoverFragmentFromCopilot,
  },
  {
    prefix: '.claude/rules/',
    providerId: 'claude',
    matches: (path) => path.startsWith('.claude/rules/') && path.endsWith('.md'),
    recover: recoverFragmentFromClaudeRule,
  },
];

/** One recovered scoped fragment candidate, keyed under `.agents/instructions/<name>.md`. */
interface DiscoveredFragment {
  /** Canonical fragment name (the `.agents/instructions/<name>.md` stem). */
  name: string;
  providerId: ProviderId;
  /** Repo-relative path of the source provider file. */
  sourcePath: string;
  /** Verbatim original file content, backed up before the source is displaced (#37). */
  sourceContent: string;
  scope: string;
  body: string;
}

/**
 * #37 + C6 (#44): the resolution outcome for one fragment that becomes
 * canonical — the candidates that contributed and which one (if any) was
 * chosen. Drives the backup + removal split: provider-directory originals are
 * removed (so the projected `hh.*` twin does not double-load), while a
 * canonical-home (`.agents/instructions/`) source is overwritten in place and
 * backed up only when a contradiction replaced its content (AD5/AD6).
 */
interface FragmentOutcome {
  /** All candidate sources discovered for this fragment name. */
  candidates: DiscoveredFragment[];
  /** Source path of the chosen candidate, or null for an AI-merge (no single source). */
  chosenSourcePath: string | null;
}

function byPath(a: { path: string }, b: { path: string }): number {
  return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
}

function byProvider(a: CandidateText, b: CandidateText): number {
  return a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0;
}

/**
 * #37: true when a provider file already lives at the tool-owned `hh.`-prefixed
 * path the projection writes to (every fragment projection is `hh.<name>.…`).
 * Such a source is overwritten in place by the chained apply, so it is NOT
 * displaced; only non-`hh.` originals (the hand-authored files a user actually
 * keeps) are backed up and removed to stop the projected twin double-loading.
 */
function isHarnessOwnedFragmentPath(sourcePath: string): boolean {
  return sourcePath.slice(sourcePath.lastIndexOf('/') + 1).startsWith('hh.');
}

/**
 * C6 (#44): true when a fragment source IS the canonical home itself
 * (`.agents/instructions/<name>.md`). Reachable only under `--adopt`. Such a
 * source is overwritten in place by init's own canonical write, so — unlike a
 * provider-directory original — it is NEVER removed (removing it would delete
 * the file the write just (re)created) and is backed up only when a
 * contradiction replaces its content (AD5/AD6).
 */
function isCanonicalFragmentHome(sourcePath: string): boolean {
  return sourcePath.startsWith('.agents/instructions/');
}

/**
 * UN1 (C6 #44, revised) — "tool-canonical": harness-haircut has ALREADY
 * onboarded this repo, so `apply` (not `init`) is the right command. The
 * unambiguous markers are tool-EMITTED artifacts: the state file every
 * successful `apply` writes (`.agents/.harness-state.json`), or a root
 * `AGENTS.md` carrying a SignedSource header (only `apply` emits one). A bare
 * hand-built `.agents/` tree carries NEITHER — it is `hand-shaped`, handled by
 * `--adopt`, not by this refusal.
 */
function isToolCanonical(snapshot: RepoSnapshot, reader: ProviderFileReader): boolean {
  if (snapshot.files.some((file) => file.path === APPLY_STATE_PATH)) {
    return true;
  }
  const rootAgents = reader.read('AGENTS.md');
  return rootAgents !== null && detectHeaderPlacement(rootAgents) !== 'none';
}

/**
 * C6 (#44) — "canonical-shaped": a `.agents/` tree exists. Combined with
 * `isToolCanonical` returning false this is the HAND-BUILT case: a repo that
 * adopted `.agents/skills/` / `.agents/instructions/` by hand. Default `init`
 * refuses it toward `init --adopt` (AD2); `--adopt` proceeds (AD3).
 */
function hasCanonicalShape(snapshot: RepoSnapshot): boolean {
  return snapshot.files.some((file) => file.path.startsWith('.agents/'));
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
 *
 * SECURITY: a skill name becomes an emit path segment (`.agents/skills/<name>/`
 * and downstream `.claude/skills/<name>/`), so every discovered name is gated
 * through the same safe-name rule `parseRepo` enforces (`isSafeName`). An
 * unsafe name (path traversal, frontmatter-breaking chars) is dropped here and
 * its source path returned in `rejected` so the caller can note it rather than
 * writing a partial canonical layout that `apply` would then reject.
 */
function discoverSkills(snapshot: RepoSnapshot): {
  byName: Map<string, DiscoveredSkill[]>;
  rejected: string[];
} {
  const byName = new Map<string, DiscoveredSkill[]>();
  const rejected: string[] = [];
  const sorted = [...snapshot.files].sort(byPath);
  for (const root of SKILL_SOURCE_ROOTS) {
    for (const file of sorted) {
      const name = skillNameFromPath(file.path, root.prefix);
      if (name === null) {
        continue;
      }
      if (!isSafeName(name)) {
        rejected.push(file.path);
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
  return { byName, rejected };
}

/**
 * F1 — discovers scoped instruction fragments across the provider fragment
 * roots, grouped by canonical name. A name recovered from several providers
 * with byte-identical (normalized) scope+body collapses to one (EV1); differing
 * copies under one name become a `fragment:<name>` contradiction. Files under a
 * fragment root with NO parseable scope are collected separately so the caller
 * can surface them in notes rather than drop them.
 */
function discoverFragments(snapshot: RepoSnapshot): {
  byName: Map<string, DiscoveredFragment[]>;
  unparseable: string[];
  rejected: string[];
} {
  const byName = new Map<string, DiscoveredFragment[]>();
  const unparseable: string[] = [];
  const rejected: string[] = [];
  const sorted = [...snapshot.files].sort(byPath);
  for (const root of FRAGMENT_SOURCE_ROOTS) {
    for (const file of sorted) {
      if (!root.matches(file.path)) {
        continue;
      }
      const recovered = root.recover(file.content);
      if (recovered === null) {
        unparseable.push(file.path);
        continue;
      }
      const name = fragmentNameFromSource(file.path);
      // SECURITY: the fragment name becomes `.agents/instructions/<name>.md`,
      // so it is gated through the same safe-name rule as skills/parseRepo. An
      // unsafe name (derived from a hostile filename) is dropped + reported.
      if (!isSafeName(name)) {
        rejected.push(file.path);
        continue;
      }
      const discovered: DiscoveredFragment = {
        name,
        providerId: root.providerId,
        sourcePath: file.path,
        sourceContent: file.content,
        scope: recovered.scope,
        body: recovered.body,
      };
      const existing = byName.get(name);
      if (existing === undefined) {
        byName.set(name, [discovered]);
      } else {
        existing.push(discovered);
      }
    }
  }
  return { byName, unparseable, rejected };
}

/** Canonical `.agents/instructions/<name>.md` text: a `scope:` frontmatter over the body. */
function fragmentCanonicalText(fragment: DiscoveredFragment): string {
  const body = fragment.body.startsWith('\n') ? fragment.body.slice(1) : fragment.body;
  return `---\nscope: ${JSON.stringify(fragment.scope)}\n---\n${body}`;
}

/** Comparison key for fragment agreement (EV1): scope plus the normalized body. */
function fragmentNormalized(fragment: DiscoveredFragment): string {
  return `${fragment.scope}\n${normalizeForCompare(fragment.body)}`;
}

/** A fragment candidate as a `CandidateText` for the shared contradiction machinery. */
function fragmentCandidate(fragment: DiscoveredFragment): CandidateText {
  return {
    providerId: fragment.providerId,
    path: fragment.sourcePath,
    text: fragmentCanonicalText(fragment),
    normalizedText: fragmentNormalized(fragment),
  };
}

/** True when every candidate's normalized text is byte-identical (EV1). */
function allAgree(candidates: CandidateText[]): boolean {
  if (candidates.length === 0) {
    return true;
  }
  const first = candidates[0]!.normalizedText;
  return candidates.every((candidate) => candidate.normalizedText === first);
}

/**
 * Applies a resolution to a candidate list → the text to write, or null for
 * skip/unresolved. `merge` (C4) writes the AI-proposed, human-approved text
 * verbatim; `choose` writes the selected candidate's original text.
 */
function chosenText(candidates: CandidateText[], resolution: Resolution): string | null {
  if (resolution.kind === 'choose') {
    return candidates[resolution.index]?.text ?? null;
  }
  if (resolution.kind === 'merge') {
    return resolution.text;
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

  // ---- step 2: UN1 (C6 #44) — tool-canonical refuses toward `apply` (AD1);
  // a hand-built `.agents/` tree refuses toward `init --adopt` unless --adopt is
  // set (AD2/AD3); a non-canonical repo passes both checks and onboards (AD8).
  if (isToolCanonical(snapshot, deps.reader)) {
    return {
      exitCode: 1,
      refused: 'already-canonical',
      dryRun: flags.dryRun,
      detected,
      contradictions: [],
      planned: [],
      notes: [
        'this repo is already managed by harness-haircut (a .agents/.harness-state.json ' +
          'state file, or a generated root AGENTS.md). init onboards a repo from scratch — ' +
          'run `harness-haircut apply` to refresh projections instead.',
      ],
      backups: [],
    };
  }
  if (hasCanonicalShape(snapshot) && !flags.adopt) {
    return {
      exitCode: 1,
      refused: 'hand-canonical-needs-adopt',
      dryRun: flags.dryRun,
      detected,
      contradictions: [],
      planned: [],
      notes: [
        'this repo has a hand-built .agents/ layout but no harness-haircut state file. ' +
          'Run `harness-haircut init --adopt` to adopt that tree as canonical and consolidate ' +
          'the remaining provider files (claude-only skills, scoped instructions, the Copilot ' +
          'file) into it. (`apply` only projects an already-canonical tree; it would not import ' +
          'them.)',
      ],
      backups: [],
    };
  }

  // ---- step 2b (#35): refuse a SYMLINKED canonical home before any write ----
  // A symlinked `.agents/` slips past UN1 (the snapshot walk skips symlinks,
  // so it contributes no files) but cannot host the canonical tree: the walk
  // would never read content back out of it, and the writer refuses
  // symlinked-parent traversal — init would otherwise crash mid-onboarding
  // (exit 70) on its first canonical write, after backups were written.
  const canonicalHomeAlias = (deps.aliasOf ?? (() => null))(APPLY_STATE_PATH);
  if (canonicalHomeAlias !== null) {
    return {
      exitCode: 1,
      refused: 'symlinked-canonical-home',
      dryRun: flags.dryRun,
      detected,
      contradictions: [],
      planned: [],
      notes: [
        `.agents resolves through a symlink (.agents/* lands at ${canonicalHomeAlias.replace(/\/[^/]*$/, '')}/*). ` +
          'harness-haircut must own .agents/ as a real directory: replace the ' +
          'symlink with the directory it points to, then re-run init.',
      ],
      backups: [],
    };
  }

  // ---- step 3: build candidate canonical IR by union ----
  const rootCandidates = gatherRootCandidates(deps.reader);
  const { byName: skillsByName, rejected: rejectedSkills } = discoverSkills(snapshot);
  const {
    byName: fragmentsByName,
    unparseable: unparseableFragments,
    rejected: rejectedFragments,
  } = discoverFragments(snapshot);

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
  // F1: scoped fragments share the contradiction machinery under their own
  // `fragment:<name>` namespace (distinct from root/skill slots).
  const fragmentContradictions = new Map<string, Contradiction>();
  for (const [name, discovered] of [...fragmentsByName].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    if (discovered.length < 2) {
      continue;
    }
    const candidates = discovered.map(fragmentCandidate).sort(byProvider);
    if (!allAgree(candidates)) {
      const contradiction: Contradiction = {
        slot: `fragment:${name}`,
        candidates,
        plusSkip: true,
      };
      contradictions.push(contradiction);
      fragmentContradictions.set(name, contradiction);
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
      backups: [],
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
        backups: [],
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
          : resolution.kind === 'merge'
            ? `ai-merged (${rootCandidates.map((c) => c.providerId).join(', ')})`
            : 'skipped';
    }
  }

  // ---- decide the canonical skills ----
  const plannedSkillWrites: { path: string; content: string; origin: string }[] = [];
  // C4: notes recording sibling-attachment provenance for AI-merged skills.
  const mergeSiblingNotes: string[] = [];
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
      // C4 merge: write the AI-proposed, human-approved SKILL.md body verbatim,
      // and carry the representative candidate's sibling attachments
      // (scripts/assets) so the merged skill is not left without the files it
      // needs. The merge only reconciled the BODY text; F2 backs up each
      // candidate's body, and the siblings of every candidate also remain in
      // their original provider directories (init never deletes sources), so
      // nothing is lost — a note records which candidate's siblings were carried.
      if (resolution.kind === 'merge') {
        const origin = `ai-merged (${discovered.map((s) => s.providerId).join(', ')})`;
        plannedSkillWrites.push({
          path: `.agents/skills/${name}/SKILL.md`,
          content: resolution.text,
          origin,
        });
        const representative = discovered[0]!;
        for (const sibling of representative.files) {
          plannedSkillWrites.push({
            path: `.agents/skills/${name}/${sibling.path}`,
            content: sibling.content,
            origin,
          });
        }
        if (discovered.some((s) => s.files.length > 0)) {
          mergeSiblingNotes.push(
            `skill "${name}" was AI-merged; carried ${representative.files.length} sibling ` +
              `attachment(s) from ${representative.providerId} (${representative.path}). Other ` +
              `candidates' attachments remain in their original provider directories — review if ` +
              `they differ.`,
          );
        }
        continue;
      }
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

  // ---- decide the canonical scoped fragments (F1) ----
  const plannedFragmentWrites: { path: string; content: string; origin: string }[] = [];
  // #37 + C6: the resolution outcome per fragment that becomes canonical, used
  // below to back up + remove displaced provider originals (and, under --adopt,
  // back up a replaced canonical-home source) without silent loss.
  const fragmentOutcomes: FragmentOutcome[] = [];
  for (const [name, discoveredRaw] of [...fragmentsByName].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    // Sort identically to the contradiction's candidate order so a `choose`
    // index resolves to the same fragment the resolver was shown.
    const discovered = [...discoveredRaw].sort((a, b) =>
      a.providerId < b.providerId ? -1 : a.providerId > b.providerId ? 1 : 0,
    );
    const contradiction = fragmentContradictions.get(name);
    let chosen: DiscoveredFragment | null;
    let origin: string;
    if (contradiction === undefined) {
      // EV1: identical (or single) → carry the first/only copy, no prompt.
      chosen = discovered[0]!;
      origin =
        discovered.length > 1
          ? `agreed (${discovered.map((f) => f.providerId).join(', ')})`
          : chosen.providerId;
    } else {
      const resolution = resolutionBySlot.get(`fragment:${name}`)!;
      // C4 merge: the resolver merged the FULL canonical fragment texts (each
      // candidate's `text` is already its `fragmentCanonicalText`), so write
      // the approved merged text verbatim — do NOT re-wrap the scope header.
      if (resolution.kind === 'merge') {
        plannedFragmentWrites.push({
          path: `.agents/instructions/${name}.md`,
          content: resolution.text,
          origin: `ai-merged (${discovered.map((f) => f.providerId).join(', ')})`,
        });
        fragmentOutcomes.push({ candidates: discovered, chosenSourcePath: null });
        continue;
      }
      chosen = resolution.kind === 'choose' ? discovered[resolution.index] ?? null : null;
      origin = resolution.kind === 'choose' ? `chose ${chosen?.providerId ?? '?'}` : 'skipped';
    }
    if (chosen === null) {
      continue;
    }
    plannedFragmentWrites.push({
      path: `.agents/instructions/${name}.md`,
      content: fragmentCanonicalText(chosen),
      origin,
    });
    fragmentOutcomes.push({ candidates: discovered, chosenSourcePath: chosen.sourcePath });
  }

  // C6 (#44): a malformed EXISTING canonical fragment (under .agents/instructions/
  // but with no `scope:`, so skipped above as unparseable rather than treated as a
  // candidate) that sits exactly where a recovered provider fragment will be
  // written would be overwritten by that write. Track those paths so their
  // verbatim original is backed up (no silent loss, PRD goal 3) and the
  // "left in place" note stays honest.
  const plannedFragmentWriteByPath = new Map(plannedFragmentWrites.map((w) => [w.path, w.content]));
  const overwrittenUnparseable = unparseableFragments.filter(
    (path) => path.startsWith('.agents/instructions/') && plannedFragmentWriteByPath.has(path),
  );
  const overwrittenUnparseableSet = new Set(overwrittenUnparseable);

  // ---- assemble the planned layout ----
  const planned: PlannedFile[] = [];
  if (rootText !== null) {
    planned.push({ path: 'AGENTS.md', origin: rootOrigin });
  }
  for (const write of plannedFragmentWrites) {
    planned.push({ path: write.path, origin: write.origin });
  }
  for (const write of plannedSkillWrites) {
    planned.push({ path: write.path, origin: write.origin });
  }

  // ---- carried-over hooks note (scoped deviation: not reverse-engineered) ----
  const notes = hookNotes(detected);
  // C4: surface which candidate's sibling attachments an AI-merged skill carried.
  for (const note of mergeSiblingNotes) {
    notes.push(note);
  }
  // F1: a fragment we could not parse a scope from is never dropped silently —
  // it stays in place and we tell the user to give it canonical backing by hand.
  // (C6: exclude any overwritten below — they were NOT left in place.)
  const leftInPlaceUnparseable = unparseableFragments.filter(
    (path) => !overwrittenUnparseableSet.has(path),
  );
  if (leftInPlaceUnparseable.length > 0) {
    notes.push(
      `could not recover ${leftInPlaceUnparseable.length} scoped instruction file(s) ` +
        `(${leftInPlaceUnparseable.sort().join(', ')}) — no applyTo:/paths: frontmatter to derive a ` +
        'scope from. They were left in place; add `scope:` frontmatter under .agents/instructions/ ' +
        'by hand and re-run `harness-haircut apply` to bring them under canonical ownership.',
    );
  }
  // C6 (#44): a malformed canonical fragment replaced in place by a recovered
  // provider fragment of the same name — its original is backed up below.
  if (overwrittenUnparseable.length > 0) {
    notes.push(
      `replaced ${overwrittenUnparseable.length} malformed canonical fragment(s) lacking a ` +
        `scope: key (${overwrittenUnparseable.sort().join(', ')}) with a recovered provider ` +
        'fragment of the same name; each original was backed up to the init backup dir.',
    );
  }
  // FIX 2(a): a discovered skill/fragment whose name is not a safe path segment
  // is skipped BEFORE any write (never partially written then failed at apply),
  // and surfaced here so the source is never dropped silently (PRD goal 3).
  if (rejectedSkills.length > 0) {
    notes.push(
      `skipped ${rejectedSkills.length} skill(s) with an unsafe name ` +
        `(${rejectedSkills.sort().join(', ')}) — skill folder names must match ` +
        '^[a-z0-9]+(-[a-z0-9]+)*$ to be safe as canonical path segments. Rename the ' +
        'folder(s) and re-run `harness-haircut init`.',
    );
  }
  if (rejectedFragments.length > 0) {
    notes.push(
      `skipped ${rejectedFragments.length} scoped instruction file(s) with an unsafe ` +
        `derived name (${rejectedFragments.sort().join(', ')}) — the canonical fragment name ` +
        'must match ^[a-z0-9]+(-[a-z0-9]+)*$. Rename the file(s) and re-run `harness-haircut init`.',
    );
  }

  // ---- F2 + #37 + C6: compute the fragment backup + removal plan ----
  // Root/skill contradictions: `planBackups` stores each NON-chosen candidate's
  // recovered text. FRAGMENTS are handled here from the VERBATIM source instead:
  // a displaced provider original is preserved byte-for-byte (it would otherwise
  // double-load against the projected hh.* twin), regardless of which candidate
  // won — so fragment slots are excluded from the generic plan and re-added here.
  const aliasOf = deps.aliasOf ?? (() => null);
  const fragmentBackups: { path: string; content: string }[] = [];
  const fragmentRemovals: string[] = [];
  // Canonical-home (.agents/instructions/) originals rewritten in place with a
  // verbatim backup — surfaced in a note so the rewrite is never silent.
  const canonicalRewrites: string[] = [];
  // Each provider file yields at most one fragment, so a source path appears in
  // at most one outcome — no dedup needed across outcomes.
  for (const outcome of fragmentOutcomes) {
    for (const source of outcome.candidates) {
      const sp = source.sourcePath;
      // #35: a source reached through an in-repo symlink alias is left untouched.
      if (aliasOf(sp) !== null) {
        continue;
      }
      // hh.* projected path: apply overwrites it in place; its content is derived
      // (no unique user text), so it is neither backed up nor removed.
      if (isHarnessOwnedFragmentPath(sp)) {
        continue;
      }
      if (isCanonicalFragmentHome(sp)) {
        // AD5: the canonical home is overwritten in place by init's own write,
        // never removed. No silent loss: back up the verbatim original whenever
        // that rewrite is NOT byte-identical to the original. This covers a
        // contradiction resolved to another candidate / an AI-merge (AD6) AND a
        // lossy NORMALIZATION — `fragmentCanonicalText` emits only `scope:`+body,
        // so any extra frontmatter key (description/owner/…) or a reshaped scope
        // is dropped from the rewrite and must be recoverable. A true round-trip
        // (single-`scope:` fragment, no byte change) needs no backup.
        const rewritten = plannedFragmentWriteByPath.get(sp);
        if (rewritten === undefined || source.sourceContent !== rewritten) {
          fragmentBackups.push({
            path: `${INIT_BACKUP_DIR}/${sanitizeBackupName(sp)}`,
            content: source.sourceContent,
          });
          canonicalRewrites.push(sp);
        }
        continue;
      }
      // A provider-directory original (#37): back it up verbatim AND remove it,
      // so the projected hh.* twin becomes the only copy in that provider dir.
      fragmentBackups.push({
        path: `${INIT_BACKUP_DIR}/${sanitizeBackupName(sp)}`,
        content: source.sourceContent,
      });
      fragmentRemovals.push(sp);
    }
  }
  // C6 (#44): preserve the verbatim original of every malformed canonical
  // fragment about to be overwritten by a same-named recovered provider fragment
  // (it was not a candidate, so it would otherwise be lost silently). The write
  // overwrites it in place — it is NOT removed.
  for (const path of overwrittenUnparseable) {
    const original = deps.reader.read(path);
    if (original !== null) {
      fragmentBackups.push({
        path: `${INIT_BACKUP_DIR}/${sanitizeBackupName(path)}`,
        content: original,
      });
    }
  }
  const nonFragmentContradictions = contradictions.filter((c) => !c.slot.startsWith('fragment:'));
  const backupPlan = planBackups(nonFragmentContradictions, resolutionBySlot);
  for (const note of backupNotes(nonFragmentContradictions, resolutionBySlot)) {
    notes.push(note);
  }
  for (const backup of fragmentBackups) {
    backupPlan.push(backup);
  }
  const backups = backupPlan.map((b) => b.path);
  if (fragmentRemovals.length > 0) {
    const moves = fragmentRemovals
      .map((sp) => `${sp} -> ${INIT_BACKUP_DIR}/${sanitizeBackupName(sp)}`)
      .sort()
      .join(', ');
    notes.push(
      `consolidation recovers ${fragmentRemovals.length} provider instruction file(s) into ` +
        'canonical .agents/instructions/ and moves each original to the init backup dir, so the ' +
        `projected hh.* twin does not double-load (${moves}).`,
    );
  }
  if (canonicalRewrites.length > 0) {
    notes.push(
      `adopt rewrote ${canonicalRewrites.length} existing canonical fragment(s) in place to the ` +
        `canonical scope:+body shape (${canonicalRewrites.sort().join(', ')}); the verbatim ` +
        'original of each was backed up to the init backup dir (no content lost).',
    );
  }

  // ---- step 6: OPT2 dry-run stops here (no backups written either) ----
  if (flags.dryRun) {
    return {
      exitCode: 0,
      dryRun: true,
      detected,
      contradictions,
      planned,
      notes,
      backups: [],
    };
  }

  // ---- step 7: back up non-chosen candidates (F2), then write + project ----
  // Backups go OUTSIDE the canonical tree at the repo root so the parser walk
  // (AGENTS.md + .agents/**) never reads them back into IR — see planBackups.
  for (const backup of backupPlan) {
    deps.writer.write(backup.path, backup.content);
  }
  if (rootText !== null) {
    deps.writer.write('AGENTS.md', rootText);
  }
  for (const write of plannedFragmentWrites) {
    deps.writer.write(write.path, write.content);
  }
  for (const write of plannedSkillWrites) {
    deps.writer.write(write.path, write.content);
  }
  // #37: remove each displaced provider-directory original (its content was
  // backed up just above and now lives canonically). Done BEFORE the chained
  // apply so the hh.* twin becomes the only copy of that fragment in the provider
  // directory — otherwise the original and the projection both load (token bloat
  // + drift). Canonical-home sources are NOT here (AD5: overwritten in place by
  // the writes above, never removed).
  for (const sourcePath of fragmentRemovals) {
    deps.writer.remove(sourcePath);
  }

  const applyReport = await deps.apply();

  return {
    exitCode: applyReport.exitCode === 0 ? 0 : 1,
    dryRun: false,
    detected,
    contradictions,
    planned,
    notes,
    backups,
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

/**
 * F2 — the backup directory lives at the REPO ROOT, deliberately OUTSIDE
 * `.agents/`. The parser walk (`readRepoSnapshot` → `parseRepo`) only collects
 * `AGENTS.md` at any depth plus everything under root `.agents/`, so a
 * top-level `.harness-haircut-init-backup/` is never read back into IR or
 * re-projected by the follow-up `apply`. (Placing backups under `.agents/`
 * would be walked — the `.harness-state.json` skip lives in `parse-repo.ts`,
 * which this PR must not touch — so the root location is the safe choice.)
 */
const INIT_BACKUP_DIR = '.harness-haircut-init-backup';

/** Maps a source path to a flat, filesystem-safe backup filename. */
function sanitizeBackupName(path: string): string {
  return path.replace(/[/\\]/g, '__');
}

/**
 * F2 — for every resolved contradiction, the candidates the user did NOT pick
 * (all candidates on a skip; everyone but the chosen index otherwise) have their
 * ORIGINAL text preserved under the repo-root backup dir, so consolidation never
 * destroys content unrecoverably. `text` is the original candidate text.
 */
function planBackups(
  contradictions: Contradiction[],
  resolutionBySlot: Map<string, Resolution>,
): { path: string; content: string }[] {
  const plan: { path: string; content: string }[] = [];
  for (const contradiction of contradictions) {
    const resolution = resolutionBySlot.get(contradiction.slot);
    if (resolution === undefined) {
      continue;
    }
    contradiction.candidates.forEach((candidate, index) => {
      if (resolution.kind === 'choose' && resolution.index === index) {
        return; // the chosen candidate becomes canonical — no backup needed.
      }
      plan.push({
        path: `${INIT_BACKUP_DIR}/${sanitizeBackupName(candidate.path)}`,
        content: candidate.text,
      });
    });
  }
  return plan;
}

/** Human-readable note per resolved contradiction listing which sources were backed up. */
function backupNotes(
  contradictions: Contradiction[],
  resolutionBySlot: Map<string, Resolution>,
): string[] {
  const notes: string[] = [];
  for (const contradiction of contradictions) {
    const resolution = resolutionBySlot.get(contradiction.slot);
    if (resolution === undefined) {
      continue;
    }
    const notChosen = contradiction.candidates.filter(
      (_candidate, index) => !(resolution.kind === 'choose' && resolution.index === index),
    );
    if (notChosen.length === 0) {
      continue;
    }
    const sources = notChosen
      .map((c) => `${c.path} -> ${INIT_BACKUP_DIR}/${sanitizeBackupName(c.path)}`)
      .join(', ');
    const verb =
      resolution.kind === 'choose'
        ? 'not chosen'
        : resolution.kind === 'merge'
          ? 'superseded by the AI-merged text'
          : 'skipped';
    notes.push(
      `contradiction "${contradiction.slot}": ${notChosen.length} ${verb} candidate(s) ` +
        `had their original content backed up (${sources}).`,
    );
  }
  return notes;
}
