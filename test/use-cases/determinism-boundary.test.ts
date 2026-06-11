/**
 * PRD §17 / C4 — the determinism-boundary proof.
 *
 * The PRD §17 boundary and C4 (docs/stories/13-C4-ai-assisted-init.md U3 +
 * its final acceptance line) require that an LLM / provider SDK / provider CLI
 * NEVER runs on the deterministic path (`audit` / `apply`). This file proves
 * that two complementary ways:
 *
 *   Part A — E2E NO-SPAWN: prepend a dir of executable STUBS named exactly
 *     claude/codex/gemini/copilot to PATH, run the built CLI's `audit` and
 *     `apply`, and assert none of those stubs ever fired (each stub would
 *     append to a sentinel file if spawned). Because the host actually has
 *     real `claude`/`codex`/`copilot` on PATH, shadowing them with stubs makes
 *     this both SAFE (no real paid call can happen) and MEANINGFUL (a bare-name
 *     spawn on the deterministic path would hit the stub and be caught).
 *
 *   Part B — static SDK assertion: read the built deterministic-path modules
 *     and assert none import a provider SDK, while the SDK module specifiers DO
 *     appear in the lazy `assist-backends.js` backend — structurally proving the
 *     SDK reference is isolated off the deterministic path.
 *
 * Offline only: no real provider tool is invoked, no network is touched.
 */
import { describe, it, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve, dirname, join, delimiter } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  mkdtempSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
  readFileSync,
  existsSync,
  chmodSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';

// Resolve the built CLI the same way test/cli.test.ts does.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..', '..');
const binPath = resolve(repoRoot, 'dist', 'bin.js');

/** The four provider CLIs that must never be spawned on the deterministic path. */
const PROVIDER_CLIS = ['claude', 'codex', 'gemini', 'copilot'] as const;

describe('PRD §17 / C4 determinism boundary', () => {
  describe('Part A — no provider CLI is spawned on audit/apply (E2E)', () => {
    const cleanups: Array<() => void> = [];
    let fakebinDir: string;
    let sentinelPath: string;
    let repoRootTmp: string;

    /** Env that shadows the four provider CLIs with our stubs ahead of the real PATH. */
    const stubbedEnv = (): NodeJS.ProcessEnv => ({
      ...process.env,
      PATH: fakebinDir + delimiter + (process.env.PATH ?? ''),
      HH_SENTINEL: sentinelPath,
    });

    before(() => {
      // A throwaway dir holding the four executable stubs + the sentinel.
      fakebinDir = mkdtempSync(join(tmpdir(), 'hh-fakebin-'));
      cleanups.push(() => rmSync(fakebinDir, { recursive: true, force: true }));
      sentinelPath = join(fakebinDir, 'spawned.log');

      // Each stub records its own name + args to $HH_SENTINEL then exits 0, so
      // a single existsSync/read of the sentinel tells us whether ANY of the
      // four provider CLIs was spawned. `"$@"` is quoted so args with spaces
      // are recorded faithfully; the stub never needs the real binary.
      for (const name of PROVIDER_CLIS) {
        const stubPath = join(fakebinDir, name);
        writeFileSync(
          stubPath,
          `#!/bin/sh\nprintf '%s %s\\n' "${name}" "$*" >> "$HH_SENTINEL"\nexit 0\n`,
          'utf8',
        );
        chmodSync(stubPath, 0o755);
      }

      // A minimal canonical layout (mirrors cli.test.ts's apply `canonicalRepo`
      // fixture) so both `audit` and `apply` have real work to do: an AGENTS.md,
      // a skill, and a hook. mkdtemp gives no `.git`, so `apply` needs
      // --allow-dirty (the tree "cannot be verified clean" → treated dirty).
      repoRootTmp = mkdtempSync(join(tmpdir(), 'hh-determinism-repo-'));
      cleanups.push(() => rmSync(repoRootTmp, { recursive: true, force: true }));
      const files: Record<string, string> = {
        'AGENTS.md': '# Project standards\n\nUse npm test.\n',
        '.agents/skills/foo/SKILL.md':
          '---\nname: foo\ndescription: Use when fooing\n---\n# Foo\n\nDo it.\n',
        '.agents/hooks/pre-tool-use.lint.sh': '#!/usr/bin/env bash\necho lint\n',
      };
      for (const [rel, content] of Object.entries(files)) {
        const abs = join(repoRootTmp, ...rel.split('/'));
        mkdirSync(dirname(abs), { recursive: true });
        writeFileSync(abs, content, 'utf8');
      }
    });

    after(() => {
      for (const cleanup of cleanups) {
        cleanup();
      }
    });

    /** True iff the sentinel exists and has non-empty content (a stub fired). */
    const sentinelFired = (): { fired: boolean; contents: string } => {
      if (!existsSync(sentinelPath)) {
        return { fired: false, contents: '' };
      }
      const contents = readFileSync(sentinelPath, 'utf8');
      return { fired: contents.trim() !== '', contents };
    };

    it('runs `audit` without spawning any provider CLI', () => {
      const r = spawnSync(process.execPath, [binPath, 'audit', '--cwd', repoRootTmp], {
        encoding: 'utf8',
        env: stubbedEnv(),
      });
      // audit on this fixture exits 0 (clean — apply hasn't run) or 2 (only a
      // lossy warning); never a system error. The exit code is incidental — the
      // assertion that matters is the no-spawn one below.
      assert.ok(
        r.status === 0 || r.status === 1 || r.status === 2,
        `audit exited with an unexpected status ${r.status}: ${r.stderr}`,
      );
      const { fired, contents } = sentinelFired();
      assert.equal(
        fired,
        false,
        `DETERMINISM-BOUNDARY VIOLATION: a provider CLI was spawned during \`audit\`. ` +
          `Sentinel contents:\n${contents}`,
      );
    });

    it('runs `apply` without spawning any provider CLI', () => {
      // --allow-dirty: the temp repo has no .git, so the git gateway reports
      // "cannot verify clean" → dirty; --allow-dirty lets apply run to
      // completion and actually write the projection (real deterministic work).
      const r = spawnSync(
        process.execPath,
        [binPath, 'apply', '--cwd', repoRootTmp, '--allow-dirty'],
        { encoding: 'utf8', env: stubbedEnv() },
      );
      assert.equal(r.status, 0, `apply did not exit 0: ${r.stderr || r.stdout}`);
      // Sanity: apply actually did deterministic work (wrote a provider file),
      // so the no-spawn result below is about a path that genuinely ran.
      assert.equal(
        existsSync(join(repoRootTmp, '.github', 'copilot-instructions.md')),
        true,
        'apply did not write the expected projection — the fixture may be wrong',
      );
      const { fired, contents } = sentinelFired();
      assert.equal(
        fired,
        false,
        `DETERMINISM-BOUNDARY VIOLATION: a provider CLI was spawned during \`apply\`. ` +
          `Sentinel contents:\n${contents}`,
      );
    });

    it('leaves the sentinel empty after BOTH audit and apply have run', () => {
      // A belt-and-suspenders summary assertion over the cumulative sentinel:
      // after both deterministic commands above, nothing should have fired.
      const { fired, contents } = sentinelFired();
      assert.equal(
        fired,
        false,
        `DETERMINISM-BOUNDARY VIOLATION: provider CLI(s) fired across the ` +
          `deterministic audit+apply runs. Sentinel contents:\n${contents}`,
      );
    });

    it('`doctor` runs under the same stubs (scope note — no-spawn NOT asserted here)', () => {
      // SCOPE: doctor reuses the AI-assist credential DISCOVERY that
      // `init --assist` uses. Discovery is paid-call-free but it is allowed to
      // PATH-probe (a filesystem existsSync walk, NOT an exec) and may run an
      // allowed status probe such as `codex login status` to detect a logged-in
      // session. Those are deliberately permitted by U4 / PRD §17 ("paid-call-
      // free discovery"), so we DO NOT assert no-spawn for doctor — a stub
      // firing here would be `codex login status`, not a model call. We only
      // assert doctor runs cleanly with the stubs on PATH.
      const r = spawnSync(process.execPath, [binPath, 'doctor', '--cwd', repoRootTmp], {
        encoding: 'utf8',
        env: stubbedEnv(),
      });
      assert.equal(r.status, 0, `doctor did not exit 0: ${r.stderr}`);
      assert.match(r.stdout, /harness-haircut doctor/);
    });
  });

  describe('Part B — no provider SDK import on the deterministic path (static)', () => {
    /**
     * The provider-SDK module specifiers as they appear in source/built code.
     * We match the IMPORT FORM — the exact quoted module specifier — rather than
     * a loose substring. This is load-bearing: `dist/entities/secret-scan.js`
     * legitimately contains the word `OpenAI` in a comment and a secret-scan
     * rule id `'openai-api-key'`; a loose `openai` substring search would yield
     * a false positive there. The bare specifier `'openai'` (quote-openai-quote)
     * appears ONLY in the lazy SDK map in assist-backends.js.
     */
    const SDK_SPECIFIERS = ['@anthropic-ai/sdk', 'openai', '@google/generative-ai'] as const;

    /** Deterministic-path built modules that must be SDK-free. */
    const deterministicFiles = [
      resolve(repoRoot, 'dist', 'use-cases', 'audit.js'),
      resolve(repoRoot, 'dist', 'use-cases', 'apply.js'),
      resolve(repoRoot, 'dist', 'use-cases', 'doctor.js'),
      resolve(repoRoot, 'dist', 'use-cases', 'parse-repo.js'),
      ...listEntityJsFiles(),
    ];

    const backendFile = resolve(repoRoot, 'dist', 'gateways', 'assist-backends.js');

    /**
     * Returns whether `source` references `specifier` as a module specifier —
     * i.e. as a single- or double-quoted string literal exactly equal to the
     * module name (the form a static `import` or `await import('<name>')` takes
     * once built). Substring-in-a-longer-string (e.g. `'openai-api-key'`) and
     * bare words in comments (e.g. `OpenAI`) deliberately do NOT match.
     */
    const importsSpecifier = (source: string, specifier: string): boolean =>
      source.includes(`'${specifier}'`) || source.includes(`"${specifier}"`);

    it('locates every built file under test (build is current)', () => {
      for (const file of [...deterministicFiles, backendFile]) {
        assert.equal(existsSync(file), true, `expected built file missing: ${file}`);
      }
      // Guard against the entity glob silently returning nothing.
      assert.ok(listEntityJsFiles().length > 0, 'no dist/entities/*.js files found');
    });

    for (const specifier of SDK_SPECIFIERS) {
      it(`does not import the "${specifier}" SDK from any deterministic-path module`, () => {
        const offenders = deterministicFiles.filter((file) =>
          importsSpecifier(readFileSync(file, 'utf8'), specifier),
        );
        assert.deepEqual(
          offenders,
          [],
          `DETERMINISM-BOUNDARY VIOLATION: the "${specifier}" SDK specifier appears on the ` +
            `deterministic path in:\n${offenders.join('\n')}`,
        );
      });
    }

    it('isolates all three SDK specifiers inside the lazy assist-backends gateway', () => {
      // Proves the boundary structurally: the SDK references that are forbidden
      // above DO exist — they are confined to the lazily-imported backend.
      const backendSource = readFileSync(backendFile, 'utf8');
      for (const specifier of SDK_SPECIFIERS) {
        assert.equal(
          importsSpecifier(backendSource, specifier),
          true,
          `expected the "${specifier}" SDK specifier in assist-backends.js; if the SDK map ` +
            `moved, update this test (the boundary proof depends on the reference living here).`,
        );
      }
    });

    it('confirms the false-positive guard: secret-scan.js mentions OpenAI but never imports the SDK specifier', () => {
      // Documents WHY we match the quoted specifier rather than a substring:
      // secret-scan.js contains `OpenAI` / `'openai-api-key'`, yet must not be
      // flagged. If this ever fails, the matching strategy needs revisiting.
      const secretScan = resolve(repoRoot, 'dist', 'entities', 'secret-scan.js');
      if (existsSync(secretScan)) {
        const source = readFileSync(secretScan, 'utf8');
        assert.equal(
          importsSpecifier(source, 'openai'),
          false,
          'the bare "openai" module specifier unexpectedly appears in secret-scan.js',
        );
      }
    });
  });
});

/** Lists `dist/entities/*.js` (excluding `.d.ts` / `.js.map`), absolute paths. */
function listEntityJsFiles(): string[] {
  const dir = resolve(repoRoot, 'dist', 'entities');
  if (!existsSync(dir)) {
    return [];
  }
  return readdirSync(dir)
    .filter((name) => name.endsWith('.js') && !name.endsWith('.d.ts'))
    .map((name) => join(dir, name));
}
