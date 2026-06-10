import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { createProviderFileReader } from '../../dist/index.js';
import { mkTempRepo } from '../_helpers/tmp-repo.ts';
import type { TempRepo } from '../_helpers/tmp-repo.ts';

describe('createProviderFileReader', () => {
  const repos: TempRepo[] = [];
  after(async () => {
    await Promise.all(repos.map((repo) => repo.cleanup()));
  });
  async function repoWith(files: Record<string, string>): Promise<TempRepo> {
    const repo = await mkTempRepo(files);
    repos.push(repo);
    return repo;
  }

  it('reads file content rooted at cwd', async () => {
    const repo = await repoWith({ '.codex/hooks.json': '{"hooks":{}}\n' });
    const reader = createProviderFileReader(repo.root);
    assert.equal(reader.read('.codex/hooks.json'), '{"hooks":{}}\n');
  });

  it('reports existence of files but not directories', async () => {
    const repo = await repoWith({ '.claude/rules/hh.x.md': 'x\n' });
    const reader = createProviderFileReader(repo.root);
    assert.equal(reader.exists('.claude/rules/hh.x.md'), true);
    assert.equal(reader.exists('.claude/rules'), false);
    assert.equal(reader.exists('.claude/rules/missing.md'), false);
  });

  it('returns null for a missing file', async () => {
    const repo = await repoWith({});
    const reader = createProviderFileReader(repo.root);
    assert.equal(reader.read('CLAUDE.md'), null);
    assert.equal(reader.exists('CLAUDE.md'), false);
  });

  it('returns null when a directory sits at the requested path', async () => {
    const repo = await repoWith({ '.claude/settings.json': '{}\n' });
    const reader = createProviderFileReader(repo.root);
    assert.equal(reader.read('.claude'), null);
  });

  it('treats an empty file as existing with empty content, not absent', async () => {
    const repo = await repoWith({ '.gemini/settings.json': '' });
    const reader = createProviderFileReader(repo.root);
    assert.equal(reader.read('.gemini/settings.json'), '');
    assert.equal(reader.exists('.gemini/settings.json'), true);
  });

  it('strips a leading UTF-8 BOM from file content', async () => {
    const repo = await repoWith({ 'CLAUDE.md': '﻿@AGENTS.md\n' });
    const reader = createProviderFileReader(repo.root);
    assert.equal(reader.read('CLAUDE.md'), '@AGENTS.md\n');
  });

  it('roots two readers at distinct cwds independently', async () => {
    const a = await repoWith({ 'AGENTS.md': 'A\n' });
    const b = await repoWith({ 'AGENTS.md': 'B\n' });
    assert.equal(createProviderFileReader(a.root).read('AGENTS.md'), 'A\n');
    assert.equal(createProviderFileReader(b.root).read('AGENTS.md'), 'B\n');
  });
});
