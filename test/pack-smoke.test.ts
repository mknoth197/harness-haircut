import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync, copyFileSync } from 'node:fs';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';

/**
 * I2 (#15) U2 / acceptance: `npm pack` then `npx -p ./<tarball>
 * harness-haircut --version` works in a clean directory. This packs the real
 * package, installs the tarball into a throwaway temp dir via npx, and asserts
 * the printed version matches package.json.
 *
 * GATED behind HH_PACK_SMOKE=1: `npx -p <tarball>` performs a real (network-
 * touching) install into npx's cache, which is slow and flaky in offline/
 * sandboxed CI. It is NOT part of the default `npm test`. Run it explicitly:
 *
 *   HH_PACK_SMOKE=1 node --test "test/pack-smoke.test.ts"
 *
 * CI can run it in a dedicated, network-enabled job before publishing.
 */
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '..');
const pkgVersion = (
  JSON.parse(readFileSync(resolve(repoRoot, 'package.json'), 'utf8')) as { version: string }
).version;

const enabled = process.env['HH_PACK_SMOKE'] === '1';

describe('npm pack smoke (gated by HH_PACK_SMOKE=1)', () => {
  const tempDirs: string[] = [];
  after(() => {
    for (const dir of tempDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it(
    'npx -p ./<tarball> harness-haircut --version prints the version',
    { skip: enabled ? false : 'set HH_PACK_SMOKE=1 to run (network/cache-touching)' },
    () => {
      // 1) Pack the real package. `npm pack` prints the tarball filename last.
      const pack = spawnSync('npm', ['pack'], { cwd: repoRoot, encoding: 'utf8' });
      assert.equal(pack.status, 0, `npm pack failed: ${pack.stderr}`);
      const tarball = pack.stdout.trim().split('\n').pop() ?? '';
      assert.match(tarball, /^harness-haircut-.*\.tgz$/);

      // 2) Copy the tarball into a clean temp dir (no package.json there).
      const cleanDir = mkdtempSync(join(tmpdir(), 'hh-pack-smoke-'));
      tempDirs.push(cleanDir);
      const tarballSrc = resolve(repoRoot, tarball);
      const tarballDst = join(cleanDir, tarball);
      copyFileSync(tarballSrc, tarballDst);
      rmSync(tarballSrc, { force: true });

      // 3) Run the published CLI through npx against the tarball.
      const run = spawnSync('npx', ['-p', `./${tarball}`, 'harness-haircut', '--version'], {
        cwd: cleanDir,
        encoding: 'utf8',
      });
      assert.equal(run.status, 0, `npx run failed: ${run.stderr}`);
      assert.equal(run.stdout.trim(), pkgVersion);
    },
  );
});
