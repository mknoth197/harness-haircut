import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export interface TempRepo {
  root: string;
  cleanup(): Promise<void>;
}

/**
 * Creates a throwaway repo under os.tmpdir() from a map of repo-relative
 * POSIX paths to file contents (testing.md: integration tests run against a
 * real filesystem with per-test setup + teardown).
 */
export async function mkTempRepo(files: Record<string, string>): Promise<TempRepo> {
  const root = await mkdtemp(join(tmpdir(), 'harness-haircut-test-'));
  for (const [relPath, content] of Object.entries(files)) {
    const abs = join(root, ...relPath.split('/'));
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf8');
  }
  return {
    root,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
