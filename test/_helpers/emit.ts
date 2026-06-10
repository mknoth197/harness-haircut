/**
 * Apply-equivalent emission for C1 integration/E2E tests. `apply` (C2) does
 * not exist yet, so the audit tests need a way to put a *clean* set of
 * projected files on disk: parse the repo, run every adapter, write each
 * overwrite file verbatim, and shallow-merge each merge-key file's owned key
 * into a JSON object at that path. This deliberately mirrors what C2 will do
 * — it is the inverse of what `audit` checks — so a freshly emitted repo
 * audits clean.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  parseRepo,
  readRepoSnapshot,
  createAllAdapters,
  createProviderFileReader,
} from '../../dist/index.js';
import type { ProjectionContext, ProviderId } from '../../dist/index.js';

async function writeRel(root: string, relPath: string, content: string): Promise<void> {
  const abs = join(root, ...relPath.split('/'));
  await mkdir(dirname(abs), { recursive: true });
  await writeFile(abs, content, 'utf8');
}

function setDeep(obj: Record<string, unknown>, dotKey: string, value: unknown): void {
  const segments = dotKey.split('.');
  let cursor = obj;
  for (let i = 0; i < segments.length - 1; i++) {
    const seg = segments[i]!;
    if (typeof cursor[seg] !== 'object' || cursor[seg] === null) {
      cursor[seg] = {};
    }
    cursor = cursor[seg] as Record<string, unknown>;
  }
  cursor[segments[segments.length - 1]!] = value;
}

export interface EmitOptions {
  geminiMode?: 'settings' | 'shim';
}

/** Emits the clean projection of `root` back onto `root` (apply-equivalent). */
export async function emitProjection(root: string, options: EmitOptions = {}): Promise<void> {
  const { ir } = await parseRepo({ readRepo: () => readRepoSnapshot(root) });
  const reader = createProviderFileReader(root);
  const merged = new Map<string, Record<string, unknown>>();

  for (const adapter of createAllAdapters()) {
    const ctx: ProjectionContext = { cwd: root, providerFiles: reader };
    if (adapter.id === 'gemini') {
      ctx.providerConfig = { mode: options.geminiMode ?? 'settings' };
    }
    const projection = adapter.project(ir, ctx);
    for (const file of projection.files) {
      if (file.mode === 'overwrite') {
        await writeRel(root, file.path, file.body);
      } else {
        const obj = merged.get(file.path) ?? {};
        setDeep(obj, file.mergeKey ?? '', JSON.parse(file.body));
        merged.set(file.path, obj);
      }
    }
  }

  for (const [path, obj] of merged) {
    await writeRel(root, path, `${JSON.stringify(obj, null, 2)}\n`);
  }
}

/** Convenience: a projection context factory matching the CLI's. */
export function contextFactory(
  root: string,
  reader: ReturnType<typeof createProviderFileReader>,
  geminiMode: 'settings' | 'shim' = 'settings',
): (id: ProviderId) => ProjectionContext {
  return (id: ProviderId) => {
    const ctx: ProjectionContext = { cwd: root, providerFiles: reader };
    if (id === 'gemini') {
      ctx.providerConfig = { mode: geminiMode };
    }
    return ctx;
  };
}
