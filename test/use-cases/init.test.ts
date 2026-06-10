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

function runAudit(root: string) {
  const reader = createProviderFileReader(root);
  return audit({
    parse: () => parseRepo({ readRepo: () => readRepoSnapshot(root) }),
    adapters: createAllAdapters(),
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
