/**
 * File mutation seam — C2 (#12). The `apply` use case (layer 2) is pure and
 * makes every disk change through this injected interface; the filesystem
 * implementation lives in `src/gateways/fs-writer.ts` (layer 3) and tests use
 * a pure in-memory implementation. Writes are the ONLY mutation surface in
 * the system — `audit` reads through `ProviderFileReader` and never writes.
 *
 * Paths are repo-relative POSIX, the same convention as `EmittedFile.path`
 * and `ProviderFileReader`. `read`/`exists` overlap the reader's shape so a
 * single object can satisfy both contracts when convenient, but the two
 * interfaces are kept distinct so a use case's read-only intent is visible in
 * its dependency list.
 */
export interface FileWriter {
  /** Returns the file content, or `null` when the file does not exist. */
  read(path: string): string | null;
  exists(path: string): boolean;
  /**
   * Writes `content` to `path`, creating parent directories as needed. The
   * write fully replaces any existing file at the path (no append).
   */
  write(path: string, content: string): void;
}

/**
 * Pure in-memory `FileWriter` over a path → content map, for use-case unit
 * tests. Mutations land in the backing `Map`; `snapshot()` returns a plain
 * record copy so a test can assert on the exact set of writes.
 */
export function createMemoryWriter(initial: Record<string, string> = {}): FileWriter & {
  snapshot(): Record<string, string>;
} {
  const byPath = new Map(Object.entries(initial));
  return {
    read: (path) => byPath.get(path) ?? null,
    exists: (path) => byPath.has(path),
    write: (path, content) => {
      byPath.set(path, content);
    },
    snapshot: () => Object.fromEntries(byPath),
  };
}
