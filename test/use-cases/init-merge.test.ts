/**
 * `init` use case — C4 AI-assist MERGE handling. INTEGRATION tests against a
 * real filesystem in os.tmpdir() (testing.md category 2): each test builds a
 * tiny NON-canonical repo, runs `init` with a HAND-ROLLED fake
 * `resolveContradiction` that returns `{ kind: 'merge', text }` for the
 * contradiction slot, and asserts the merge outcome on disk + in the report.
 *
 * No network, no CLI, no model calls: the "AI" resolver is a deterministic
 * stub that hands back a fixed merged string. The merged text is invented here
 * (NEVER a real credential) and must land VERBATIM as canonical, superseding
 * every candidate.
 *
 * Coverage (C4 EV2/EV4 + F2 no-loss; init.ts merge branches):
 *   - root-instructions merge → canonical AGENTS.md is the MERGED text verbatim
 *     (init.ts:554,559,724), PlannedFile.origin reads `ai-merged (...)`
 *     (init.ts:559).
 *   - F2: ALL candidates backed up (none "chosen"), report.backups lists each
 *     sanitized path, backup content === each candidate's ORIGINAL recovered
 *     text (init.ts:698,box planBackups:814-822).
 *   - EV4 idempotency: a second apply over the canonical tree leaves the merged
 *     AGENTS.md body byte-stable.
 *   - fragment:<name> merge → `.agents/instructions/<name>.md` is the merged
 *     text verbatim, NO re-wrapped scope header (init.ts:634-638).
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  init,
  apply,
  parseRepo,
  readRepoSnapshot,
  readInitSnapshot,
  createAllAdapters,
  createProviderFileReader,
  createFileWriter,
  parseState,
  serializeState,
  APPLY_STATE_PATH,
} from '../../dist/index.js';
import type {
  ApplyState,
  Contradiction,
  InitReport,
  Resolution,
} from '../../dist/index.js';
import { mkTempRepo } from '../_helpers/tmp-repo.ts';
import type { TempRepo } from '../_helpers/tmp-repo.ts';
import { contextFactory } from '../_helpers/emit.ts';

const repos: TempRepo[] = [];
after(async () => {
  await Promise.all(repos.map((repo) => repo.cleanup()));
});

async function setup(files: Record<string, string>): Promise<TempRepo> {
  const repo = await mkTempRepo(files);
  repos.push(repo);
  return repo;
}

interface RunInitOptions {
  /** Scripted resolutions per contradiction slot; default is "skip". */
  resolve?: Record<string, Resolution>;
  /** Records every slot the resolver was asked about. */
  resolverCalls?: string[];
}

/**
 * Mirrors init.test.ts's wiring exactly: real snapshot/reader/writer/adapters
 * and the real `apply`, with a hand-rolled `resolveContradiction`. The only
 * difference is this resolver can return `{ kind: 'merge', text }` — that is the
 * C4 AI-assist outcome a deterministic resolver never produces, stubbed here so
 * no model is ever called.
 */
function runInit(root: string, options: RunInitOptions = {}): Promise<InitReport> {
  const reader = createProviderFileReader(root);
  const writer = createFileWriter(root);
  const adapters = createAllAdapters();
  const resolveContradiction = (contradiction: Contradiction): Promise<Resolution> => {
    options.resolverCalls?.push(contradiction.slot);
    return Promise.resolve(options.resolve?.[contradiction.slot] ?? { kind: 'skip' });
  };
  return init({
    snapshot: () => readInitSnapshot(root),
    reader,
    writer,
    adapters,
    resolveContradiction,
    apply: () =>
      apply({
        parse: () => parseRepo({ readRepo: () => readRepoSnapshot(root) }),
        adapters,
        reader,
        writer,
        contextFor: contextFactory(root, reader),
        isDirty: () => Promise.resolve(false),
        confirm: () => Promise.resolve(false),
        readState: (): ApplyState => parseState(reader.read(APPLY_STATE_PATH)),
        writeState: (state: ApplyState): void =>
          writer.write(APPLY_STATE_PATH, serializeState(state)),
        flags: { allowDirty: true, dryRun: false, nonInteractive: true },
      }),
    flags: { dryRun: false, nonInteractive: false },
  });
}

/** Standalone apply over an already-canonical tree (same wiring as init's apply). */
function runApply(root: string) {
  const reader = createProviderFileReader(root);
  const writer = createFileWriter(root);
  const adapters = createAllAdapters();
  return apply({
    parse: () => parseRepo({ readRepo: () => readRepoSnapshot(root) }),
    adapters,
    reader,
    writer,
    contextFor: contextFactory(root, reader),
    isDirty: () => Promise.resolve(false),
    confirm: () => Promise.resolve(false),
    readState: (): ApplyState => parseState(reader.read(APPLY_STATE_PATH)),
    writeState: (state: ApplyState): void => writer.write(APPLY_STATE_PATH, serializeState(state)),
    flags: { allowDirty: true, dryRun: false, nonInteractive: true },
  });
}

describe('init() — C4 root-instructions merge (EV2/EV4, F2)', () => {
  // Two root sources whose RECOVERED text differs: a CLAUDE.md shim (its body
  // below `@AGENTS.md` is the candidate) and a hand-written root AGENTS.md with
  // different prose. init surfaces ONE `root-instructions` contradiction.
  const claudeBody = '# Project standards\n\nUse npm test.\nRun the linter before pushing.\n';
  const claudeSource = `@AGENTS.md\n\n${claudeBody}`;
  // What `recoverFromShim` returns for `claudeSource`: it strips only the first
  // `@AGENTS.md` line (slicing after the first newline), so the LEADING blank
  // line below the import is preserved. This is the CLAUDE.md candidate's
  // original recovered text — exactly what F2 backs up verbatim.
  const claudeRecovered = `\n${claudeBody}`;
  const agentsText = '# Project standards\n\nUse pnpm test.\nFormat with prettier.\n';
  // The AI-proposed, human-approved merge: reconciles both, verbatim canonical.
  const merged =
    '# Project standards\n\n' +
    'Use npm test (the canonical runner).\n' +
    'Run the linter before pushing.\n' +
    'Format with prettier.\n';

  async function drifted(): Promise<TempRepo> {
    return setup({
      'CLAUDE.md': claudeSource,
      'AGENTS.md': agentsText,
    });
  }

  it('writes the MERGED text verbatim as canonical AGENTS.md (not either candidate)', async () => {
    const repo = await drifted();
    const resolverCalls: string[] = [];
    const report = await runInit(repo.root, {
      resolverCalls,
      resolve: { 'root-instructions': { kind: 'merge', text: merged } },
    });

    assert.equal(report.exitCode, 0);
    assert.deepEqual(resolverCalls, ['root-instructions']);
    assert.equal(report.contradictions.length, 1);
    assert.equal(report.contradictions[0]!.slot, 'root-instructions');

    const written = await readFile(join(repo.root, 'AGENTS.md'), 'utf8');
    // EV2: the merged text lands byte-for-byte, superseding BOTH candidates.
    assert.equal(written, merged);
    // It is neither candidate's original recovered text.
    assert.notEqual(written, claudeBody);
    assert.notEqual(written, agentsText);
    // Sanity: a token unique to each original candidate is gone from canonical.
    assert.doesNotMatch(written, /Use pnpm test\./); // AGENTS.md-only line
    assert.match(written, /Use npm test \(the canonical runner\)\./); // merge-only line
  });

  it('records the AGENTS.md PlannedFile.origin as "ai-merged (...)"', async () => {
    const repo = await drifted();
    const report = await runInit(repo.root, {
      resolve: { 'root-instructions': { kind: 'merge', text: merged } },
    });
    assert.equal(report.exitCode, 0);
    const plannedAgents = report.planned.find((file) => file.path === 'AGENTS.md');
    assert.ok(plannedAgents !== undefined, 'AGENTS.md is in the planned layout');
    // init.ts:559 — origin reads `ai-merged (<provider>, <provider>)`.
    assert.match(plannedAgents.origin, /^ai-merged \(/);
    // Both contributing providers are named (candidates are provider-sorted:
    // claude < codex, so the hand-written AGENTS.md is the codex candidate).
    assert.match(plannedAgents.origin, /claude/);
    assert.match(plannedAgents.origin, /codex/);
  });

  it('F2: backs up EVERY candidate (merge supersedes all; none is chosen)', async () => {
    const repo = await drifted();
    const report = await runInit(repo.root, {
      resolve: { 'root-instructions': { kind: 'merge', text: merged } },
    });
    assert.equal(report.exitCode, 0);

    // Candidate paths sanitized: '/' → '__' under the repo-root backup dir.
    const claudeBackupRel = '.harness-haircut-init-backup/CLAUDE.md';
    const agentsBackupRel = '.harness-haircut-init-backup/AGENTS.md';

    // The report lists BOTH (so --json and the human report surface them).
    assert.equal(report.backups.length, 2);
    assert.ok(report.backups.includes(claudeBackupRel));
    assert.ok(report.backups.includes(agentsBackupRel));

    // The backup content equals each candidate's ORIGINAL recovered/source text.
    // CLAUDE.md's candidate is its body BELOW the `@AGENTS.md` shim line, NOT the
    // raw shim file — that is the recovered text init would have written.
    const claudeBackup = await readFile(join(repo.root, claudeBackupRel), 'utf8');
    assert.equal(claudeBackup, claudeRecovered);
    assert.doesNotMatch(claudeBackup, /@AGENTS\.md/); // shim line was stripped on recovery

    // AGENTS.md is already canonical shape → its candidate text is verbatim.
    const agentsBackup = await readFile(join(repo.root, agentsBackupRel), 'utf8');
    assert.equal(agentsBackup, agentsText);

    // A human-readable note flags the merge-supersession backup.
    assert.ok(
      report.notes.some(
        (n) => /backed up/i.test(n) && /superseded by the AI-merged text/i.test(n),
      ),
    );
  });

  it('EV4: a second apply leaves the merged AGENTS.md body byte-stable', async () => {
    const repo = await drifted();
    const report = await runInit(repo.root, {
      resolve: { 'root-instructions': { kind: 'merge', text: merged } },
    });
    assert.equal(report.exitCode, 0);
    // init already ran apply once (the projection pass). Capture the canonical
    // root doc after that first projection.
    const afterFirstApply = await readFile(join(repo.root, 'AGENTS.md'), 'utf8');
    assert.equal(afterFirstApply, merged); // apply must not touch the canonical source

    // A SECOND apply over the resulting canonical tree must not rewrite/mangle it.
    const second = await runApply(repo.root);
    assert.notEqual(second.exitCode, 3);
    const afterSecondApply = await readFile(join(repo.root, 'AGENTS.md'), 'utf8');
    assert.equal(afterSecondApply, afterFirstApply); // byte-stable across re-apply
    assert.equal(afterSecondApply, merged);
    // Root AGENTS.md is a canonical SOURCE (codex reads it natively), so apply
    // never lists it among the files it rewrote.
    assert.ok(!second.written.includes('AGENTS.md'));
  });
});

describe('init() — C4 fragment:<name> merge writes verbatim, no re-wrapped scope (F2)', () => {
  // Two providers contribute a same-named scoped fragment with DIFFERING bodies
  // → ONE `fragment:security` contradiction. The merged text is the FULL
  // canonical fragment text (its own `scope:` frontmatter), written verbatim.
  const copilotFragment = '---\napplyTo: "src/**"\n---\n# Security\n\nCopilot: never log secrets.\n';
  const claudeRule = '---\npaths: ["src/**"]\n---\n# Security\n\nClaude: redact tokens in logs.\n';
  // The merge is itself a valid canonical fragment (one `scope:` header) — the
  // resolver merged the two candidates' full `fragmentCanonicalText` forms.
  const mergedFragment =
    '---\nscope: "src/**"\n---\n# Security\n\nNever log secrets; redact tokens in logs.\n';

  async function driftedFragments(): Promise<TempRepo> {
    return setup({
      'CLAUDE.md': '@AGENTS.md\n\n# A\nUse npm.\n',
      '.github/instructions/security.instructions.md': copilotFragment,
      '.claude/rules/security.md': claudeRule,
    });
  }

  it('writes the merged fragment verbatim to .agents/instructions/<name>.md', async () => {
    const repo = await driftedFragments();
    const resolverCalls: string[] = [];
    const report = await runInit(repo.root, {
      resolverCalls,
      resolve: { 'fragment:security': { kind: 'merge', text: mergedFragment } },
    });
    assert.equal(report.exitCode, 0);
    assert.ok(resolverCalls.includes('fragment:security'));
    const fragmentSlots = report.contradictions.filter((c) => c.slot === 'fragment:security');
    assert.equal(fragmentSlots.length, 1);

    const fragmentPath = join(repo.root, '.agents', 'instructions', 'security.md');
    assert.equal(existsSync(fragmentPath), true);
    const written = await readFile(fragmentPath, 'utf8');
    // EV2: the merged canonical fragment lands byte-for-byte.
    assert.equal(written, mergedFragment);
    // It is neither candidate's recovered form.
    assert.doesNotMatch(written, /Copilot: never log secrets\./);
    assert.doesNotMatch(written, /Claude: redact tokens in logs\./);
  });

  it('does NOT re-wrap a scope header around the merged text', async () => {
    const repo = await driftedFragments();
    const report = await runInit(repo.root, {
      resolve: { 'fragment:security': { kind: 'merge', text: mergedFragment } },
    });
    assert.equal(report.exitCode, 0);
    const written = await readFile(
      join(repo.root, '.agents', 'instructions', 'security.md'),
      'utf8',
    );
    // The merged text is THE full canonical fragment — no second header was
    // wrapped around it (init.ts:634-638 writes resolution.text verbatim).
    const scopeHeaderCount = (written.match(/^---\nscope:/gm) ?? []).length;
    assert.equal(scopeHeaderCount, 1);
    // No double front-matter fence at the very top (would betray a re-wrap).
    assert.doesNotMatch(written, /^---\n---/);
    // The recovered scope is not duplicated.
    assert.equal((written.match(/scope:/g) ?? []).length, 1);
  });

  it('records the fragment PlannedFile.origin as "ai-merged (...)" and backs up both candidates', async () => {
    const repo = await driftedFragments();
    const report = await runInit(repo.root, {
      resolve: { 'fragment:security': { kind: 'merge', text: mergedFragment } },
    });
    assert.equal(report.exitCode, 0);
    const plannedFragment = report.planned.find(
      (file) => file.path === '.agents/instructions/security.md',
    );
    assert.ok(plannedFragment !== undefined);
    assert.match(plannedFragment.origin, /^ai-merged \(/);

    // F2: both source fragments (claude rule + copilot instructions) are backed
    // up under sanitized paths, with their ORIGINAL source bytes preserved.
    const claudeBackupRel = '.harness-haircut-init-backup/.claude__rules__security.md';
    const copilotBackupRel =
      '.harness-haircut-init-backup/.github__instructions__security.instructions.md';
    assert.ok(report.backups.includes(claudeBackupRel));
    assert.ok(report.backups.includes(copilotBackupRel));
  });

  it('EV4: a second apply leaves the merged fragment body byte-stable', async () => {
    const repo = await driftedFragments();
    const report = await runInit(repo.root, {
      resolve: { 'fragment:security': { kind: 'merge', text: mergedFragment } },
    });
    assert.equal(report.exitCode, 0);
    const fragmentPath = join(repo.root, '.agents', 'instructions', 'security.md');
    const afterFirst = await readFile(fragmentPath, 'utf8');
    assert.equal(afterFirst, mergedFragment);

    const second = await runApply(repo.root);
    assert.notEqual(second.exitCode, 3);
    const afterSecond = await readFile(fragmentPath, 'utf8');
    // The canonical fragment is a SOURCE, not an emitted file → byte-stable.
    assert.equal(afterSecond, afterFirst);
    assert.ok(!second.written.includes('.agents/instructions/security.md'));
  });
});
