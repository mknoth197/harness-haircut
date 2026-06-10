import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { doctor } from '../../dist/use-cases/doctor.js';
import { createAllAdapters } from '../../dist/adapters/index.js';
import type { RepoSnapshot } from '../../dist/entities/adapter.js';

function snapshotOf(files: Record<string, string>): RepoSnapshot {
  return {
    root: '/tmp/repo',
    files: Object.entries(files).map(([path, content]) => ({ path, content })),
  };
}

const baseDeps = {
  version: '0.1.0',
  nodeVersion: 'v24.0.0',
  cwd: '/tmp/repo',
  adapters: createAllAdapters(),
  configPath: 'harness-haircut.config.json',
};

describe('doctor()', () => {
  it('lists detected providers from existing config files', async () => {
    const snapshot = snapshotOf({
      'CLAUDE.md': '@AGENTS.md\n',
      '.codex/hooks.json': '{"version":1,"hooks":{}}\n',
    });
    const report = await doctor({
      ...baseDeps,
      snapshot: () => Promise.resolve(snapshot),
      configRaw: null,
    });
    assert.equal(report.exitCode, 0);
    const ids = report.detectedProviders.map((p) => p.providerId).sort();
    assert.deepEqual(ids, ['claude', 'codex']);
  });

  it('reports the injected version, node version, and cwd', async () => {
    const report = await doctor({
      ...baseDeps,
      snapshot: () => Promise.resolve(snapshotOf({})),
      configRaw: null,
    });
    assert.equal(report.version, '0.1.0');
    assert.equal(report.nodeVersion, 'v24.0.0');
    assert.equal(report.cwd, '/tmp/repo');
    assert.deepEqual(report.detectedProviders, []);
  });

  it('returns defaults when no config file is present', async () => {
    const report = await doctor({
      ...baseDeps,
      snapshot: () => Promise.resolve(snapshotOf({})),
      configRaw: null,
    });
    assert.notEqual(report.config, null);
    assert.equal(report.config?.gemini.mode, 'settings');
    assert.equal(report.exitCode, 0);
  });

  it('exits 3 and warns when the config is invalid (does not throw)', async () => {
    const report = await doctor({
      ...baseDeps,
      snapshot: () => Promise.resolve(snapshotOf({})),
      configRaw: '{ not valid json',
    });
    assert.equal(report.exitCode, 3);
    assert.equal(report.config, null);
    assert.equal(report.warnings.length, 1);
    assert.match(report.warnings[0] ?? '', /invalid config/);
  });

  it('produces a JSON-serializable report shape', async () => {
    const report = await doctor({
      ...baseDeps,
      snapshot: () => Promise.resolve(snapshotOf({ 'CLAUDE.md': '@AGENTS.md\n' })),
      configRaw: '{ "gemini": { "mode": "shim" } }',
    });
    const json = JSON.parse(JSON.stringify(report)) as {
      version: string;
      nodeVersion: string;
      cwd: string;
      detectedProviders: { providerId: string; paths: string[] }[];
      config: { gemini: { mode: string } } | null;
      warnings: string[];
      exitCode: number;
    };
    assert.equal(json.version, '0.1.0');
    assert.equal(json.config?.gemini.mode, 'shim');
    assert.ok(Array.isArray(json.detectedProviders));
    assert.ok(Array.isArray(json.warnings));
    assert.equal(json.exitCode, 0);
  });
});
