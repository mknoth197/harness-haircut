/**
 * Backup locations for preserved originals — shared by `init` and `apply`
 * (layer 1: pure constants + a pure path transform, no I/O).
 *
 * Both directories live at the REPO ROOT, deliberately OUTSIDE `.agents/`. The
 * parser walk (`readRepoSnapshot` → `parseRepo`) collects only `AGENTS.md` at
 * any depth plus everything under root `.agents/`, so a preserved original at
 * the repo root is never read back into the IR or re-projected by a follow-up
 * `apply`. (Placing backups under `.agents/` would be walked.)
 *
 * `sanitizeBackupName` flattens a source path's separators, so a backed-up
 * `sub/AGENTS.md` lands as `sub__AGENTS.md` — basename ≠ `AGENTS.md` — and is
 * therefore not re-collected by the "any-depth AGENTS.md" rule either.
 */

/** Where `init` preserves non-chosen contradiction candidates + displaced fragment originals (F2/#37). */
export const INIT_BACKUP_DIR = '.harness-haircut-init-backup';

/**
 * Where `apply` preserves a hand-written, never-tool-owned (`unmanaged`)
 * provider file before taking that path over for the first time (#40), so the
 * irreplaceable original is recoverable even after the overwrite is confirmed.
 */
export const APPLY_BACKUP_DIR = '.harness-haircut-apply-backup';

/** Maps a repo-relative source path to a flat, filesystem-safe backup filename. */
export function sanitizeBackupName(path: string): string {
  return path.replace(/[/\\]/g, '__');
}
