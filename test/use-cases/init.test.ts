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
 *   UN1  — already-canonical (.agents/ exists) fast-fails, writes nothing.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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
        flags: { allowDirty: true, dryRun: options.dryRun ?? false, nonInteractive: true },
      }),
    flags: { dryRun: options.dryRun ?? false, nonInteractive: options.nonInteractive ?? false },
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

describe('init() — UN1 already-canonical fast-fail', () => {
  it('fails (exit 1) and writes nothing when .agents/ exists', async () => {
    const repo = await setup({
      'AGENTS.md': '# Project\n',
      '.agents/skills/foo/SKILL.md':
        '---\nname: foo\ndescription: Use when fooing\n---\n# Foo\n',
      'CLAUDE.md': '@AGENTS.md\n',
    });
    const report = await runInit(repo.root);
    assert.equal(report.exitCode, 1);
    assert.equal(report.refused, 'already-canonical');
    assert.equal(report.planned.length, 0);
    // Nothing new written: no apply, no provider files.
    assert.equal(report.apply, undefined);
    assert.equal(existsSync(join(repo.root, '.github', 'copilot-instructions.md')), false);
  });

  it('fails when root AGENTS.md is itself a generated/projected file', async () => {
    const repo = await setup({
      'AGENTS.md':
        '<!-- @generated SignedSource<<<aaaaaaaaaaaaaaaa.bbbbbbbbbbbbbbbb>>> harness-haircut DO NOT EDIT -->\n' +
        '# Project\n',
    });
    const report = await runInit(repo.root);
    assert.equal(report.exitCode, 1);
    assert.equal(report.refused, 'already-canonical');
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
    flags: { allowDirty: true, dryRun: false, nonInteractive: true },
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
