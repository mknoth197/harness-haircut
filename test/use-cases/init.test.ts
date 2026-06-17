/**
 * `init` use case — INTEGRATION tests against a real filesystem in
 * os.tmpdir() (testing.md category 2). Each test builds a tiny NON-canonical
 * repo (drifted provider files, no .agents/), runs `init` with injected
 * gateways + a scripted contradiction resolver + the real `apply`, then
 * asserts the contradiction handling, the canonical writes, and (for the
 * happy path) that a follow-up `audit` exits 0.
 *
 * Every C3 EARS rule maps to at least one `it` here:
 *   U1   — pipeline: detect → candidate IR → contradictions → resolve →
 *          write canonical → invoke apply (the auto-merge + audit-0 test).
 *   EV1  — identical candidates auto-merge, no resolver call.
 *   EV2  — differing candidates surface ONE contradiction.
 *   EV3  — the resolver's choice is recorded and written.
 *   OPT1 — --non-interactive fails (exit 1) on any contradiction, writes none.
 *   OPT2 — --dry-run reports the planned layout, writes nothing, no apply.
 *   UN1  — tool-canonical (state file / generated AGENTS.md) fast-fails toward
 *          `apply`; a hand-built .agents/ fast-fails toward `init --adopt` (C6 #44).
 *   AD1-AD8 — `init --adopt` adopts a hand-built canonical repo (C6 #44).
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  init,
  apply,
  audit,
  parseRepo,
  readRepoSnapshot,
  readInitSnapshot,
  createAllAdapters,
  createProviderFileReader,
  createFileWriter,
  parseState,
  serializeState,
  APPLY_STATE_PATH,
  createSymlinkAliasProbe,
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
  dryRun?: boolean;
  nonInteractive?: boolean;
  /** C6 (#44): adopt a hand-built `.agents/` tree as canonical. */
  adopt?: boolean;
  /** Scripted resolutions per contradiction slot; default is "skip". */
  resolve?: Record<string, Resolution>;
  /** Records every slot the resolver was asked about. */
  resolverCalls?: string[];
}

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
    resolveContradiction: options.nonInteractive
      ? () => Promise.resolve<Resolution>({ kind: 'unresolved' })
      : resolveContradiction,
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
        aliasOf: createSymlinkAliasProbe(root),
        flags: { allowDirty: true, dryRun: options.dryRun ?? false, nonInteractive: true, claimUnmanaged: true },
      }),
    aliasOf: createSymlinkAliasProbe(root),
    flags: {
      dryRun: options.dryRun ?? false,
      nonInteractive: options.nonInteractive ?? false,
      adopt: options.adopt ?? false,
    },
  });
}

function runAudit(root: string, excludeProviders: string[] = []) {
  const reader = createProviderFileReader(root);
  return audit({
    parse: () => parseRepo({ readRepo: () => readRepoSnapshot(root) }),
    adapters: createAllAdapters().filter((adapter) => !excludeProviders.includes(adapter.id)),
    reader,
    contextFor: contextFactory(root, reader),
  });
}

describe('init() — zero-contradiction onboarding (U1, EV1)', () => {
  it('auto-merges identical CLAUDE.md + GEMINI.md, writes canonical AGENTS.md, no resolver call', async () => {
    const body = '@AGENTS.md\n\n# Project standards\n\nUse npm test.\n';
    const repo = await setup({
      'CLAUDE.md': body,
      'GEMINI.md': body,
    });
    const resolverCalls: string[] = [];
    const report = await runInit(repo.root, { resolverCalls });

    assert.equal(report.exitCode, 0);
    assert.deepEqual(report.contradictions, []);
    assert.deepEqual(resolverCalls, []); // EV1: agreement → no prompt
    assert.equal(existsSync(join(repo.root, 'AGENTS.md')), true);
    const written = await readFile(join(repo.root, 'AGENTS.md'), 'utf8');
    assert.match(written, /Use npm test\./);
    // U1: init invoked apply, which projected provider files.
    assert.ok(report.apply !== undefined);
    assert.ok(report.apply.written.length > 0);
  });

  it('after init on a drifted repo, audit() exits 0 (U1 end-to-end)', async () => {
    const body = '@AGENTS.md\n\n# Project standards\n\nUse npm test.\n';
    const repo = await setup({
      'CLAUDE.md': body,
      'GEMINI.md': body,
    });
    await runInit(repo.root);
    const auditReport = await runAudit(repo.root);
    assert.equal(auditReport.exitCode, 0);
  });

  it('takes a verbatim hand-written AGENTS.md as the candidate (no .agents/, not generated)', async () => {
    const repo = await setup({
      'AGENTS.md': '# Project standards\n\nUse npm test.\n',
    });
    const report = await runInit(repo.root);
    assert.equal(report.exitCode, 0);
    assert.deepEqual(report.contradictions, []);
    const auditReport = await runAudit(repo.root);
    assert.equal(auditReport.exitCode, 0);
  });
});

describe('init() — single contradiction (EV2, EV3)', () => {
  async function drifted(): Promise<TempRepo> {
    return setup({
      'CLAUDE.md': '@AGENTS.md\n\n# Project standards\n\nUse npm test.\n',
      '.github/copilot-instructions.md':
        '<!-- This file exists for Copilot code review, which does not read AGENTS.md. ' +
        'AGENTS.md is the authoritative source — edit it and re-run harness-haircut apply. -->\n\n' +
        '# Project standards\n\nUse pnpm test.\n',
    });
  }

  it('surfaces exactly one root-instructions contradiction and invokes the resolver once', async () => {
    const repo = await drifted();
    const resolverCalls: string[] = [];
    await runInit(repo.root, {
      resolverCalls,
      resolve: { 'root-instructions': { kind: 'choose', index: 0 } },
    });
    assert.deepEqual(resolverCalls, ['root-instructions']);
  });

  it('records and writes the chosen candidate (EV3)', async () => {
    const repo = await drifted();
    // Candidates are sorted by provider id: claude (npm) before copilot (pnpm).
    const report = await runInit(repo.root, {
      resolve: { 'root-instructions': { kind: 'choose', index: 1 } }, // copilot → pnpm
    });
    assert.equal(report.exitCode, 0);
    const written = await readFile(join(repo.root, 'AGENTS.md'), 'utf8');
    assert.match(written, /Use pnpm test\./);
    assert.doesNotMatch(written, /Use npm test\./);
  });

  it('skip resolution writes no AGENTS.md but still succeeds', async () => {
    const repo = await drifted();
    const report = await runInit(repo.root, {
      resolve: { 'root-instructions': { kind: 'skip' } },
    });
    assert.equal(report.exitCode, 0);
    assert.equal(existsSync(join(repo.root, 'AGENTS.md')), false);
  });
});

describe('init() — OPT1 --non-interactive', () => {
  it('fails (exit 1) on a contradiction, listing it, writing nothing', async () => {
    const repo = await setup({
      'CLAUDE.md': '@AGENTS.md\n\n# A\nUse npm test.\n',
      '.github/copilot-instructions.md': '# A\nUse pnpm test.\n',
    });
    const report = await runInit(repo.root, { nonInteractive: true });
    assert.equal(report.exitCode, 1);
    assert.equal(report.refused, 'unresolved-contradictions');
    assert.equal(report.contradictions.length, 1);
    assert.equal(report.planned.length, 0);
    assert.equal(existsSync(join(repo.root, 'AGENTS.md')), false);
  });

  it('succeeds (exit 0) when there are no contradictions', async () => {
    const body = '@AGENTS.md\n\n# A\nUse npm test.\n';
    const repo = await setup({ 'CLAUDE.md': body, 'GEMINI.md': body });
    const report = await runInit(repo.root, { nonInteractive: true });
    assert.equal(report.exitCode, 0);
    assert.equal(existsSync(join(repo.root, 'AGENTS.md')), true);
  });
});

describe('init() — OPT2 --dry-run', () => {
  it('reports the planned layout, writes nothing, does not call apply', async () => {
    const body = '@AGENTS.md\n\n# A\nUse npm test.\n';
    const repo = await setup({ 'CLAUDE.md': body, 'GEMINI.md': body });
    const report = await runInit(repo.root, { dryRun: true });
    assert.equal(report.exitCode, 0);
    assert.equal(report.dryRun, true);
    assert.ok(report.planned.some((file) => file.path === 'AGENTS.md'));
    assert.equal(report.apply, undefined); // apply NOT called
    assert.equal(existsSync(join(repo.root, 'AGENTS.md')), false);
    assert.equal(existsSync(join(repo.root, '.github', 'copilot-instructions.md')), false);
  });
});

describe('init() — UN1 tool-canonical vs hand-built distinction (C6 #44)', () => {
  it('AD2: a hand-built .agents/ (no state file) without --adopt refuses toward init --adopt, writes nothing', async () => {
    const repo = await setup({
      'AGENTS.md': '# Project\n',
      '.agents/skills/foo/SKILL.md':
        '---\nname: foo\ndescription: Use when fooing\n---\n# Foo\n',
      'CLAUDE.md': '@AGENTS.md\n',
    });
    const report = await runInit(repo.root);
    assert.equal(report.exitCode, 1);
    assert.equal(report.refused, 'hand-canonical-needs-adopt');
    assert.equal(report.planned.length, 0);
    // Nothing new written: no apply, no provider files.
    assert.equal(report.apply, undefined);
    assert.equal(existsSync(join(repo.root, '.github', 'copilot-instructions.md')), false);
  });

  it('AD1: a SignedSource root AGENTS.md is tool-canonical → already-canonical (recommend apply)', async () => {
    const repo = await setup({
      'AGENTS.md':
        '<!-- @generated SignedSource<<<aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb>>> harness-haircut DO NOT EDIT -->\n' +
        '# Project\n',
    });
    const report = await runInit(repo.root);
    assert.equal(report.exitCode, 1);
    assert.equal(report.refused, 'already-canonical');
  });

  it('AD1: a .agents/.harness-state.json marks the repo tool-canonical, even with --adopt', async () => {
    const repo = await setup({
      'AGENTS.md': '# Project\n',
      '.agents/.harness-state.json': '{\n  "version": 1,\n  "emitted": {}\n}\n',
      '.agents/skills/foo/SKILL.md':
        '---\nname: foo\ndescription: Use when fooing\n---\n# Foo\n',
    });
    const report = await runInit(repo.root, { adopt: true });
    assert.equal(report.exitCode, 1);
    assert.equal(report.refused, 'already-canonical');
    assert.equal(report.planned.length, 0);
    assert.equal(report.apply, undefined);
  });
});

describe('init() — skill carry-over', () => {
  it('carries an identical same-name skill once, no contradiction', async () => {
    const skill = '---\nname: foo\ndescription: Use when fooing\n---\n# Foo\n\nDo it.\n';
    const repo = await setup({
      'CLAUDE.md': '@AGENTS.md\n\n# A\nUse npm.\n',
      'GEMINI.md': '@AGENTS.md\n\n# A\nUse npm.\n',
      '.claude/skills/foo/SKILL.md': skill,
      '.codex/skills/foo/SKILL.md': skill,
    });
    const report = await runInit(repo.root);
    assert.equal(report.exitCode, 0);
    assert.ok(report.contradictions.every((c) => c.slot !== 'skill:foo'));
    assert.equal(existsSync(join(repo.root, '.agents', 'skills', 'foo', 'SKILL.md')), true);
  });

  it('surfaces a contradiction for same-name skills with differing bodies', async () => {
    const repo = await setup({
      'CLAUDE.md': '@AGENTS.md\n\n# A\nUse npm.\n',
      'GEMINI.md': '@AGENTS.md\n\n# A\nUse npm.\n',
      '.claude/skills/foo/SKILL.md':
        '---\nname: foo\ndescription: Use when fooing\n---\n# Foo\n\nClaude variant.\n',
      '.codex/skills/foo/SKILL.md':
        '---\nname: foo\ndescription: Use when fooing\n---\n# Foo\n\nCodex variant.\n',
    });
    const resolverCalls: string[] = [];
    const report = await runInit(repo.root, {
      resolverCalls,
      resolve: { 'skill:foo': { kind: 'choose', index: 0 } },
    });
    assert.equal(report.exitCode, 0);
    assert.ok(report.contradictions.some((c) => c.slot === 'skill:foo'));
    assert.ok(resolverCalls.includes('skill:foo'));
    const written = await readFile(join(repo.root, '.agents', 'skills', 'foo', 'SKILL.md'), 'utf8');
    // Candidates are provider-sorted: claude < codex, so index 0 is the Claude variant.
    assert.match(written, /Claude variant\./);
    assert.doesNotMatch(written, /Codex variant\./);
  });
});

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
    flags: { allowDirty: true, dryRun: false, nonInteractive: true, claimUnmanaged: true },
  });
}

describe('init() — F1 scoped fragment recovery', () => {
  it('recovers a Copilot *.instructions.md fragment into canonical .agents/instructions/<name>.md', async () => {
    const repo = await setup({
      'CLAUDE.md': '@AGENTS.md\n\n# A\nUse npm.\n',
      '.github/instructions/security.instructions.md':
        '---\napplyTo: "src/**"\n---\n# Security\n\nNever log secrets.\n',
    });
    const report = await runInit(repo.root);
    assert.equal(report.exitCode, 0);
    const fragmentPath = join(repo.root, '.agents', 'instructions', 'security.md');
    assert.equal(existsSync(fragmentPath), true);
    const written = await readFile(fragmentPath, 'utf8');
    assert.match(written, /scope: "src\/\*\*"/);
    assert.match(written, /Never log secrets\./);
    // it is consolidated, no per-fragment "left in place" note for recovered ones.
    assert.ok(!report.notes.some((n) => /could not recover/i.test(n)));

    // #37: the original is displaced — removed so the projected hh.* twin does
    // not double-load, with its verbatim content preserved in the backup dir.
    assert.equal(
      existsSync(join(repo.root, '.github', 'instructions', 'security.instructions.md')),
      false,
    );
    assert.equal(
      existsSync(join(repo.root, '.github', 'instructions', 'hh.security.instructions.md')),
      true,
    );
    const backupRel = '.harness-haircut-init-backup/.github__instructions__security.instructions.md';
    assert.ok(report.backups.includes(backupRel));
    const backedUp = await readFile(join(repo.root, backupRel), 'utf8');
    assert.equal(backedUp, '---\napplyTo: "src/**"\n---\n# Security\n\nNever log secrets.\n');
    assert.ok(report.notes.some((n) => /consolidation recovers/i.test(n)));
  });

  it('#37: displaces a Claude .claude/rules/<name>.md original too, leaving only the hh.* twin', async () => {
    // The double-load generalizes beyond Copilot: the Claude rules projection is
    // also hh.*-prefixed, so a recovered non-hh rule must be removed + backed up.
    const repo = await setup({
      'CLAUDE.md': '@AGENTS.md\n\n# A\nUse npm.\n',
      '.claude/rules/testing.md': '---\npaths: ["test/**"]\n---\n# Testing\n\nUse node:test.\n',
    });
    const report = await runInit(repo.root);
    assert.equal(report.exitCode, 0);
    assert.equal(existsSync(join(repo.root, '.agents', 'instructions', 'testing.md')), true);
    assert.equal(existsSync(join(repo.root, '.claude', 'rules', 'testing.md')), false);
    assert.equal(existsSync(join(repo.root, '.claude', 'rules', 'hh.testing.md')), true);
    assert.ok(report.backups.includes('.harness-haircut-init-backup/.claude__rules__testing.md'));
    // No double-load: a follow-up audit is clean (gemini excluded — it cannot
    // path-scope fragments, HH-W007 → exit 2, orthogonal to this fix).
    const auditReport = await runAudit(repo.root, ['gemini']);
    assert.equal(auditReport.exitCode, 0);
  });

  it('does NOT displace an original already at the tool-owned hh.* path (apply overwrites it in place)', async () => {
    // An hh.*-prefixed source IS the projection target, so it is overwritten in
    // place — never removed, and not backed up (it carries no user-authored
    // original distinct from the projection).
    const repo = await setup({
      'CLAUDE.md': '@AGENTS.md\n\n# A\nUse npm.\n',
      '.github/instructions/hh.security.instructions.md':
        '---\napplyTo: "src/**"\n---\n# Security\n\nNever log secrets.\n',
    });
    const report = await runInit(repo.root);
    assert.equal(report.exitCode, 0);
    assert.equal(
      existsSync(join(repo.root, '.github', 'instructions', 'hh.security.instructions.md')),
      true,
    );
    assert.deepEqual(report.backups, []);
    assert.ok(!report.notes.some((n) => /consolidation recovers/i.test(n)));
  });

  it('#37 dry-run: previews fragment consolidation but removes/backs up nothing', async () => {
    const repo = await setup({
      'CLAUDE.md': '@AGENTS.md\n\n# A\nUse npm.\n',
      '.github/instructions/security.instructions.md':
        '---\napplyTo: "src/**"\n---\n# Security\n\nNever log secrets.\n',
    });
    const report = await runInit(repo.root, { dryRun: true });
    assert.equal(report.exitCode, 0);
    assert.deepEqual(report.backups, []);
    // The original is untouched; nothing canonical or backup was written.
    assert.equal(
      existsSync(join(repo.root, '.github', 'instructions', 'security.instructions.md')),
      true,
    );
    assert.equal(existsSync(join(repo.root, '.agents', 'instructions', 'security.md')), false);
    assert.equal(existsSync(join(repo.root, '.harness-haircut-init-backup')), false);
  });

  it('after recovery, audit() exits 0 and a follow-up apply does NOT clobber the orphan as unmanaged', async () => {
    // A harness-prefixed orphan (`hh.*`) is exactly an apply-OWNED path that
    // would otherwise be overwritten as `unmanaged` (apply.ts:224) with no
    // prompt. Recovery gives it canonical backing so apply re-projects it.
    const repo = await setup({
      'CLAUDE.md': '@AGENTS.md\n\n# A\nUse npm.\n',
      '.github/instructions/hh.security.instructions.md':
        '---\napplyTo: "src/**"\n---\n# Security\n\nNever log secrets.\n',
    });
    await runInit(repo.root);

    // Gemini cannot path-scope any fragment (HH-W007 → exit 2), which is
    // inherent to scoped fragments and orthogonal to recovery correctness, so
    // we exclude it to assert the recovered fragment audits clean.
    const auditReport = await runAudit(repo.root, ['gemini']);
    assert.equal(auditReport.exitCode, 0);

    // The orphan path now has canonical backing: a second apply sees it clean,
    // never "unmanaged" (the silent-clobber path the fix closes).
    const followUp = await runApply(repo.root);
    const copilotEntry = followUp.files.find(
      (f) => f.path === '.github/instructions/hh.security.instructions.md',
    );
    assert.ok(copilotEntry !== undefined);
    assert.notEqual(copilotEntry.reason, 'unmanaged');
  });

  it('surfaces ONE fragment:<name> contradiction when copilot and claude disagree on the same name', async () => {
    const repo = await setup({
      'CLAUDE.md': '@AGENTS.md\n\n# A\nUse npm.\n',
      '.github/instructions/security.instructions.md':
        '---\napplyTo: "src/**"\n---\n# Security\n\nCopilot variant.\n',
      '.claude/rules/security.md': '---\npaths: ["src/**"]\n---\n# Security\n\nClaude variant.\n',
    });
    const resolverCalls: string[] = [];
    const report = await runInit(repo.root, {
      resolverCalls,
      resolve: { 'fragment:security': { kind: 'choose', index: 0 } },
    });
    assert.equal(report.exitCode, 0);
    const fragmentSlots = report.contradictions.filter((c) => c.slot === 'fragment:security');
    assert.equal(fragmentSlots.length, 1);
    assert.ok(resolverCalls.includes('fragment:security'));
    // Candidates provider-sorted: claude < copilot, so index 0 is the Claude variant.
    const written = await readFile(
      join(repo.root, '.agents', 'instructions', 'security.md'),
      'utf8',
    );
    assert.match(written, /Claude variant\./);
    assert.doesNotMatch(written, /Copilot variant\./);
  });

  it('does NOT prompt when same-named fragments from two providers agree (EV1)', async () => {
    const repo = await setup({
      'CLAUDE.md': '@AGENTS.md\n\n# A\nUse npm.\n',
      '.github/instructions/security.instructions.md':
        '---\napplyTo: "src/**"\n---\n# Security\n\nShared.\n',
      '.claude/rules/security.md': '---\npaths: ["src/**"]\n---\n# Security\n\nShared.\n',
    });
    const resolverCalls: string[] = [];
    const report = await runInit(repo.root, { resolverCalls });
    assert.equal(report.exitCode, 0);
    assert.deepEqual(resolverCalls, []);
    assert.ok(report.contradictions.every((c) => c.slot !== 'fragment:security'));
    assert.equal(existsSync(join(repo.root, '.agents', 'instructions', 'security.md')), true);
  });

  it('surfaces an unparseable fragment (no paths:/applyTo:) in notes rather than dropping it', async () => {
    const repo = await setup({
      'CLAUDE.md': '@AGENTS.md\n\n# A\nUse npm.\n',
      '.claude/rules/x.md': '# No frontmatter here\n\nfree-floating prose.\n',
    });
    const report = await runInit(repo.root);
    assert.equal(report.exitCode, 0);
    assert.ok(report.notes.some((n) => /could not recover/i.test(n) && /\.claude\/rules\/x\.md/.test(n)));
    assert.equal(existsSync(join(repo.root, '.agents', 'instructions', 'x.md')), false);
  });
});

describe('init() — F2 non-chosen candidate backup', () => {
  it('backs up the non-chosen (superset) candidate and reports the backup path', async () => {
    const repo = await setup({
      // claude (A) is a subset; copilot (B) is a superset with extra unique content.
      'CLAUDE.md': '@AGENTS.md\n\n# A\nUse npm test.\n',
      '.github/copilot-instructions.md':
        '# A\nUse npm test.\n\n## Extra B-only section\nCritical reviewer guidance.\n',
    });
    // Candidates provider-sorted: claude (index 0) before copilot (index 1).
    const report = await runInit(repo.root, {
      resolve: { 'root-instructions': { kind: 'choose', index: 0 } }, // choose A
    });
    assert.equal(report.exitCode, 0);

    const backupPath = join(repo.root, '.harness-haircut-init-backup', '.github__copilot-instructions.md');
    assert.equal(existsSync(backupPath), true);
    const backedUp = await readFile(backupPath, 'utf8');
    assert.match(backedUp, /Critical reviewer guidance\./);

    // The report lists the backup so --json and the human report both surface it.
    assert.ok(report.backups.includes('.harness-haircut-init-backup/.github__copilot-instructions.md'));
    assert.ok(report.notes.some((n) => /backed up/i.test(n) && /copilot-instructions/.test(n)));

    // The chosen candidate (A) is canonical; B's superset content is NOT in AGENTS.md.
    const canonical = await readFile(join(repo.root, 'AGENTS.md'), 'utf8');
    assert.doesNotMatch(canonical, /Critical reviewer guidance\./);
  });

  it('does NOT write backups under --dry-run', async () => {
    const repo = await setup({
      'CLAUDE.md': '@AGENTS.md\n\n# A\nUse npm test.\n',
      '.github/copilot-instructions.md': '# A\nUse pnpm test.\n',
    });
    const report = await runInit(repo.root, {
      dryRun: true,
      resolve: { 'root-instructions': { kind: 'choose', index: 0 } },
    });
    assert.equal(report.exitCode, 0);
    assert.deepEqual(report.backups, []);
    assert.equal(existsSync(join(repo.root, '.harness-haircut-init-backup')), false);
  });
});

describe('init() — hooks not reverse-engineered (scoped deviation)', () => {
  it('emits an informational note when provider hook configs are present', async () => {
    const repo = await setup({
      'CLAUDE.md': '@AGENTS.md\n\n# A\nUse npm.\n',
      '.claude/settings.json': '{\n  "hooks": {}\n}\n',
    });
    const report = await runInit(repo.root);
    assert.equal(report.exitCode, 0);
    assert.ok(report.notes.some((note) => /reverse-engineer|hook/i.test(note)));
  });
});

describe('init() — FIX 1 symlinked root-instruction candidate (security)', () => {
  it('does NOT recover an external secret when CLAUDE.md is a symlink to it', async () => {
    // The secret lives OUTSIDE the repo; a malicious CLAUDE.md symlinks to it.
    const outside = await mkdtemp(join(tmpdir(), 'harness-haircut-secret-'));
    const secretPath = join(outside, 'credentials');
    await writeFile(secretPath, 'AWS_SECRET_ACCESS_KEY=topsecret\n', 'utf8');

    const repo = await setup({
      // A legitimate hand-written AGENTS.md so init still has a real candidate.
      'AGENTS.md': '# Project standards\n\nUse npm test.\n',
    });
    await symlink(secretPath, join(repo.root, 'CLAUDE.md'));

    const report = await runInit(repo.root);
    assert.equal(report.exitCode, 0);
    // The symlinked candidate was skipped — the secret never reached canonical.
    const canonical = await readFile(join(repo.root, 'AGENTS.md'), 'utf8');
    assert.doesNotMatch(canonical, /topsecret/);
    assert.doesNotMatch(canonical, /AWS_SECRET_ACCESS_KEY/);
    // And no projected provider file leaked it either.
    if (existsSync(join(repo.root, '.github', 'copilot-instructions.md'))) {
      const ci = await readFile(join(repo.root, '.github', 'copilot-instructions.md'), 'utf8');
      assert.doesNotMatch(ci, /topsecret/);
    }
    // The external secret file itself is untouched (apply replaced the symlink
    // with a real in-repo shim rather than following the link to corrupt it).
    assert.equal(await readFile(secretPath, 'utf8'), 'AWS_SECRET_ACCESS_KEY=topsecret\n');

    await rm(outside, { recursive: true, force: true });
  });

  // BLOCKER 1 (live bypass, end-to-end): a symlinked PARENT dir — .github →
  // /tmp/external — with an ORDINARY real leaf (copilot-instructions.md holding
  // a secret) defeated the old leaf-only lstat. init read the secret THROUGH
  // the symlinked parent into canonical AGENTS.md and projected it everywhere.
  // Realpath-containment now treats the whole escaping chain as absent, and
  // since #35 the alias probe skips the projection up front (HH-W013) instead
  // of crashing at the writer's refusal.
  it('does NOT recover a secret behind a symlinked PARENT directory (.github → external)', async () => {
    const outside = await mkdtemp(join(tmpdir(), 'harness-haircut-external-'));
    await writeFile(
      join(outside, 'copilot-instructions.md'),
      'EXFIL_SECRET=topsecret-parent-dir\n',
      'utf8',
    );

    const repo = await setup({
      'AGENTS.md': '# Project standards\n\nUse npm test.\n',
    });
    // .github is a symlink to the external dir; the leaf behind it is a real file.
    await symlink(outside, join(repo.root, '.github'));

    // READ side: the secret behind the symlinked parent is never recovered.
    // WRITE side (#35): the alias probe now flags the escaping `.github`
    // chain BEFORE the write is attempted, so the chained apply SKIPS the
    // projection with HH-W013 and the run completes — strictly better than
    // the previous mid-run FileSystemError (exit 70), with the same
    // containment: nothing is read or written through the chain.
    const report = await runInit(repo.root);
    assert.equal(report.exitCode, 0);
    const aliasWarning = report.apply?.warnings.find(
      (w) => w.code === 'HH-W013' && w.message.includes('.github/copilot-instructions.md'),
    );
    assert.notEqual(aliasWarning, undefined);
    assert.match(aliasWarning?.message ?? '', /outside the repository/);

    // The secret never reached canonical AGENTS.md (read guard held).
    const canonical = await readFile(join(repo.root, 'AGENTS.md'), 'utf8');
    assert.doesNotMatch(canonical, /topsecret-parent-dir/);
    assert.doesNotMatch(canonical, /EXFIL_SECRET/);
    // And the external file was never clobbered by a projection write-through.
    assert.equal(
      await readFile(join(outside, 'copilot-instructions.md'), 'utf8'),
      'EXFIL_SECRET=topsecret-parent-dir\n',
    );

    await rm(outside, { recursive: true, force: true });
  });
});

describe('init() — FIX 2(a) unsafe discovered names skipped + noted', () => {
  it('skips a skill whose folder name is unsafe and notes it, writing no partial files', async () => {
    const skill = '---\nname: foo\ndescription: Use when fooing\n---\n# Foo\n\nDo it.\n';
    const repo = await setup({
      'CLAUDE.md': '@AGENTS.md\n\n# A\nUse npm.\n',
      // An unsafe skill folder name (uppercase + dot are outside the safe-name
      // rule). skillNameFromPath rejects '/', so we exercise the char rule.
      '.claude/skills/Bad.Name/SKILL.md': skill,
      // A legitimate sibling skill still carries over.
      '.claude/skills/good/SKILL.md': skill,
    });
    const report = await runInit(repo.root);
    assert.equal(report.exitCode, 0);
    // The unsafe skill is skipped — no canonical folder for it.
    assert.equal(existsSync(join(repo.root, '.agents', 'skills', 'Bad.Name', 'SKILL.md')), false);
    assert.ok(report.notes.some((n) => /unsafe name/i.test(n) && /Bad\.Name/.test(n)));
    // The valid one still landed (no partial write / no abort).
    assert.equal(existsSync(join(repo.root, '.agents', 'skills', 'good', 'SKILL.md')), true);
  });

  it('skips a scoped fragment whose derived name is unsafe and notes it', async () => {
    const repo = await setup({
      'CLAUDE.md': '@AGENTS.md\n\n# A\nUse npm.\n',
      // The derived fragment name is the basename sans suffix; uppercase/dot
      // segments are unsafe path-segment names.
      '.claude/rules/Bad.Name.md': '---\npaths: ["src/**"]\n---\n# x\n\nbody.\n',
      '.claude/rules/good.md': '---\npaths: ["src/**"]\n---\n# y\n\nbody.\n',
    });
    const report = await runInit(repo.root);
    assert.equal(report.exitCode, 0);
    assert.equal(existsSync(join(repo.root, '.agents', 'instructions', 'Bad.Name.md')), false);
    assert.ok(report.notes.some((n) => /unsafe/i.test(n) && /Bad\.Name\.md/.test(n)));
    assert.equal(existsSync(join(repo.root, '.agents', 'instructions', 'good.md')), true);
  });
});

describe('init() — #35 symlinked canonical home', () => {
  it('refuses (exit 1) when .agents is an in-repo symlink, before writing anything', async () => {
    const repo = await setup({
      'CLAUDE.md': '@AGENTS.md\n\n# Project\nUse npm test.\n',
      'cfg-agents/.keep': '',
    });
    await symlink('cfg-agents', join(repo.root, '.agents'));

    const report = await runInit(repo.root);
    assert.equal(report.exitCode, 1);
    assert.equal(report.refused, 'symlinked-canonical-home');
    assert.match(report.notes.join('\n'), /\.agents resolves through a symlink/);
    // Refused BEFORE any write: no canonical root, no backups, no projections.
    assert.equal(existsSync(join(repo.root, 'AGENTS.md')), false);
    assert.equal(existsSync(join(repo.root, '.harness-haircut-init-backup')), false);
    assert.equal(existsSync(join(repo.root, 'cfg-agents', '.harness-state.json')), false);
  });
});

describe('init() — --adopt hand-built canonical (C6 #44)', () => {
  it('AD3: adopts a hand-built repo end-to-end — imports a claude-only skill + a Copilot fragment, audit exits 0', async () => {
    const repo = await setup({
      'AGENTS.md': '# Project\n\nUse npm.\n',
      '.agents/skills/foo/SKILL.md':
        '---\nname: foo\ndescription: Use when fooing\n---\n# Foo\n',
      // claude-only skill — not yet under canonical .agents/skills/.
      '.claude/skills/bar/SKILL.md':
        '---\nname: bar\ndescription: Use when barring\n---\n# Bar\n',
      // a scoped Copilot fragment to import into canonical.
      '.github/instructions/security.instructions.md':
        '---\napplyTo: "src/**"\n---\n# Security\n\nNever log secrets.\n',
    });
    const report = await runInit(repo.root, { adopt: true });
    assert.equal(report.exitCode, 0);
    assert.notEqual(report.refused, 'hand-canonical-needs-adopt');
    // The hand-built canonical skill is retained, and the claude-only skill is
    // imported into canonical .agents/skills/.
    assert.equal(existsSync(join(repo.root, '.agents', 'skills', 'foo', 'SKILL.md')), true);
    assert.equal(existsSync(join(repo.root, '.agents', 'skills', 'bar', 'SKILL.md')), true);
    // The Copilot fragment is consolidated into canonical .agents/instructions/.
    assert.equal(existsSync(join(repo.root, '.agents', 'instructions', 'security.md')), true);
    // The full loop is clean (gemini excluded — it cannot path-scope fragments,
    // HH-W007 → exit 2, orthogonal to adoption).
    const auditReport = await runAudit(repo.root, ['gemini']);
    assert.equal(auditReport.exitCode, 0);
  });

  it('AD8: --adopt on a NON-canonical repo behaves exactly like plain init', async () => {
    const body = '@AGENTS.md\n\n# Project standards\n\nUse npm test.\n';
    const repo = await setup({ 'CLAUDE.md': body, 'GEMINI.md': body });
    const resolverCalls: string[] = [];
    const report = await runInit(repo.root, { adopt: true, resolverCalls });
    assert.equal(report.exitCode, 0);
    assert.equal(report.refused, undefined);
    assert.deepEqual(report.contradictions, []);
    assert.deepEqual(resolverCalls, []);
    assert.equal(existsSync(join(repo.root, 'AGENTS.md')), true);
    assert.ok(report.apply !== undefined && report.apply.written.length > 0);
  });

  it('AD4 + AD5: an existing canonical fragment that AGREES with a provider twin collapses (EV1), no clobber, no needless backup', async () => {
    const repo = await setup({
      'AGENTS.md': '# Project\n\nUse npm.\n',
      '.agents/instructions/security.md':
        '---\nscope: "src/**"\n---\n# Security\n\nNever log secrets.\n',
      // a same-named Copilot fragment with byte-identical (normalized) scope+body.
      '.github/instructions/security.instructions.md':
        '---\napplyTo: "src/**"\n---\n# Security\n\nNever log secrets.\n',
    });
    const resolverCalls: string[] = [];
    const report = await runInit(repo.root, { adopt: true, resolverCalls });
    assert.equal(report.exitCode, 0);
    // EV1: agreement → no fragment:security contradiction, resolver never asked.
    assert.ok(!resolverCalls.includes('fragment:security'));
    assert.ok(!report.contradictions.some((c) => c.slot === 'fragment:security'));
    // AD5: the canonical fragment is kept in place (never removed).
    assert.equal(existsSync(join(repo.root, '.agents', 'instructions', 'security.md')), true);
    // AD6: agreement → the canonical original is NOT backed up (it was chosen).
    assert.ok(
      !report.backups.includes('.harness-haircut-init-backup/.agents__instructions__security.md'),
    );
    // The provider original IS displaced (removed + backed up); only the hh.* twin remains.
    assert.equal(
      existsSync(join(repo.root, '.github', 'instructions', 'security.instructions.md')),
      false,
    );
    assert.equal(
      existsSync(join(repo.root, '.github', 'instructions', 'hh.security.instructions.md')),
      true,
    );
    assert.ok(
      report.backups.includes(
        '.harness-haircut-init-backup/.github__instructions__security.instructions.md',
      ),
    );
  });

  it('AD4 + AD6: a canonical fragment that DISAGREES surfaces a contradiction; choosing the provider backs up the canonical original verbatim', async () => {
    const canonical = '---\nscope: "src/**"\n---\n# Security\n\nOld canonical rule.\n';
    const repo = await setup({
      'AGENTS.md': '# Project\n\nUse npm.\n',
      '.agents/instructions/security.md': canonical,
      '.github/instructions/security.instructions.md':
        '---\napplyTo: "src/**"\n---\n# Security\n\nNew provider rule.\n',
    });
    const resolverCalls: string[] = [];
    // Candidates sort by providerId: [codex (canonical), copilot]; index 1 = copilot.
    const report = await runInit(repo.root, {
      adopt: true,
      resolverCalls,
      resolve: { 'fragment:security': { kind: 'choose', index: 1 } },
    });
    assert.equal(report.exitCode, 0);
    assert.ok(resolverCalls.includes('fragment:security'));
    // The provider candidate won — canonical now carries the provider's body.
    const written = await readFile(join(repo.root, '.agents', 'instructions', 'security.md'), 'utf8');
    assert.match(written, /New provider rule\./);
    // AD6: the replaced canonical original is preserved VERBATIM in the backup dir.
    const canonicalBackup = '.harness-haircut-init-backup/.agents__instructions__security.md';
    assert.ok(report.backups.includes(canonicalBackup));
    const backedUp = await readFile(join(repo.root, canonicalBackup), 'utf8');
    assert.equal(backedUp, canonical);
    // The provider original is also displaced (removed + backed up).
    assert.equal(
      existsSync(join(repo.root, '.github', 'instructions', 'security.instructions.md')),
      false,
    );
  });

  it('AD7: --adopt --dry-run previews the plan but writes/removes/backs-up nothing', async () => {
    const repo = await setup({
      'AGENTS.md': '# Project\n\nUse npm.\n',
      '.agents/skills/foo/SKILL.md':
        '---\nname: foo\ndescription: Use when fooing\n---\n# Foo\n',
      '.github/instructions/security.instructions.md':
        '---\napplyTo: "src/**"\n---\n# Security\n\nNever log secrets.\n',
    });
    const report = await runInit(repo.root, { adopt: true, dryRun: true });
    assert.equal(report.exitCode, 0);
    assert.equal(report.dryRun, true);
    assert.ok(report.planned.length > 0);
    // Nothing mutated: no apply, no backups, provider original untouched, no twin.
    assert.equal(report.apply, undefined);
    assert.deepEqual(report.backups, []);
    assert.equal(existsSync(join(repo.root, '.harness-haircut-init-backup')), false);
    assert.equal(
      existsSync(join(repo.root, '.github', 'instructions', 'security.instructions.md')),
      true,
    );
    assert.equal(
      existsSync(join(repo.root, '.github', 'instructions', 'hh.security.instructions.md')),
      false,
    );
  });

  it('no silent loss: a malformed canonical fragment (no scope:) overwritten by a provider twin is backed up verbatim', async () => {
    const malformed = '# Foo\n\nMalformed canonical — no scope key.\n';
    const repo = await setup({
      'AGENTS.md': '# Project\n\nUse npm.\n',
      // Lacks a `scope:` key → skipped as unparseable, NOT a candidate.
      '.agents/instructions/foo.md': malformed,
      // A valid same-named provider fragment recovers to .agents/instructions/foo.md.
      '.github/instructions/foo.instructions.md':
        '---\napplyTo: "src/**"\n---\n# Foo\n\nProvider body wins.\n',
    });
    const report = await runInit(repo.root, { adopt: true });
    assert.equal(report.exitCode, 0);
    // The provider fragment overwrote the malformed canonical file in place.
    const written = await readFile(join(repo.root, '.agents', 'instructions', 'foo.md'), 'utf8');
    assert.match(written, /Provider body wins\./);
    // The malformed original is preserved VERBATIM (never silent loss).
    const backupRel = '.harness-haircut-init-backup/.agents__instructions__foo.md';
    assert.ok(report.backups.includes(backupRel));
    assert.equal(await readFile(join(repo.root, backupRel), 'utf8'), malformed);
    // Honest notes: a "replaced ... malformed" note, and NOT a "left in place" one.
    assert.ok(report.notes.some((n) => /replaced .*malformed canonical fragment/i.test(n)));
    assert.ok(!report.notes.some((n) => /left in place/i.test(n) && /foo/.test(n)));
  });

  it('no silent loss: a canonical fragment with extra frontmatter keys is backed up verbatim before its in-place rewrite', async () => {
    // `fragmentCanonicalText` emits only scope:+body, so the in-place rewrite
    // drops description/owner — the verbatim original must be recoverable.
    const richCanonical =
      '---\nscope: "src/**"\ndescription: Hand-written security policy\nowner: platform-team\n---\n# Security\n\nNever log secrets.\n';
    const repo = await setup({
      'AGENTS.md': '# Project\n\nUse npm.\n',
      '.agents/instructions/security.md': richCanonical,
    });
    const report = await runInit(repo.root, { adopt: true });
    assert.equal(report.exitCode, 0);
    // The canonical file is normalized to scope:+body (extra keys dropped) ...
    const written = await readFile(join(repo.root, '.agents', 'instructions', 'security.md'), 'utf8');
    assert.doesNotMatch(written, /owner: platform-team/);
    // ... but the verbatim original (with the extra keys) is preserved + reported.
    const backupRel = '.harness-haircut-init-backup/.agents__instructions__security.md';
    assert.ok(report.backups.includes(backupRel));
    assert.equal(await readFile(join(repo.root, backupRel), 'utf8'), richCanonical);
    assert.ok(report.notes.some((n) => /rewrote .*canonical fragment/i.test(n)));
  });

  it('no scope broadening: a hand-written array-form scope is normalized, not captured as a literal that matches every file', async () => {
    const arrayCanonical = '---\nscope: ["src/**", "test/**"]\n---\n# Scoped\n\nRule body.\n';
    const repo = await setup({
      'AGENTS.md': '# Project\n\nUse npm.\n',
      '.agents/instructions/scoped.md': arrayCanonical,
    });
    const report = await runInit(repo.root, { adopt: true });
    assert.equal(report.exitCode, 0);
    // The scope is normalized to a comma-joined string, NOT the literal array
    // (which would downgrade to "**" — loading the rule for every file).
    const written = await readFile(join(repo.root, '.agents', 'instructions', 'scoped.md'), 'utf8');
    assert.match(written, /scope: "src\/\*\*,test\/\*\*"/);
    // Verbatim original preserved.
    assert.equal(
      await readFile(
        join(repo.root, '.harness-haircut-init-backup/.agents__instructions__scoped.md'),
        'utf8',
      ),
      arrayCanonical,
    );
    // No HH-W001 scope broadening: a follow-up audit is clean (gemini excluded —
    // HH-W007 is inherent to scoped fragments, orthogonal to this fix).
    const auditReport = await runAudit(repo.root, ['gemini']);
    assert.equal(auditReport.exitCode, 0);
  });
});
