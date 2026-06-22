/**
 * `audit` use case — C1 (#11), PRD §7/§9. Layer 2: pure orchestration with
 * injected gateways/adapters. Makes zero writes (C1 U1), never calls
 * `process.exit`, never touches stdio — it returns an `AuditReport` and the
 * composition root maps `exitCode` and renders output.
 *
 * Algorithm (PRD §12 "audit reads disk, re-runs the same pipeline, and diffs
 * the disk state against the emit step"):
 *   1. parseRepo → { ir, warnings }
 *   2. for each enabled adapter: project(ir, ctx) → files + warnings + surfaces
 *   3. for each EmittedFile, compare expected vs on-disk per its artifact
 *      class (PRD §9 "Header placement and carve-outs") → a per-file drift
 *      verdict
 *   4. assemble AuditReport with the §7 exit code
 *
 * Verify-by-class (PRD §9 v0.3.1):
 *   - overwrite with a line-1 SignedSource header (`.github/copilot-
 *     instructions.md`): four-state verify via the body's header, plus a
 *     body-equality check as the definitive signal.
 *   - overwrite frontmatter-bearing (`.claude/rules/`, `.claude/skills/`
 *     SKILL.md files, `.github/instructions/` `.instructions.md` files):
 *     four-state verify after the frontmatter.
 *   - overwrite headerless (`.codex/hooks.json`, `.github/hooks/*.json`, skill
 *     sibling attachments): full-content comparison — disk === expected body
 *     is clean, anything else is drift. `edited` vs `stale` cannot be told
 *     apart without a recorded prior emission (a C2 concern); for a read-only
 *     audit any difference is drift, which is correct.
 *   - merge-key (`.claude/settings.json`, `.gemini/settings.json`): read the
 *     disk JSON, deep-compare the owned key's current value against the
 *     projected value. Foreign keys are never audit's concern.
 *
 * The expected body emitted by each adapter already bakes in the *current*
 * SOURCES_HASH (the adapter computed it from the freshly parsed IR), so the
 * four-state verifiers compare the disk header against that expected hash
 * extracted straight from the projected body — no manifest is rebuilt, and
 * embed/verify stay on the same serialization (PRD §9).
 */
import type {
  EmittedFile,
  ProjectionContext,
  ProviderAdapter,
  ProviderFileReader,
  ProviderId,
} from '../entities/adapter.js';
import type { IR } from '../entities/ir.js';
import { detectHeaderPlacement, verifyAgainstExpected } from '../entities/signed-source.js';
import type { VerifyStatus } from '../entities/signed-source.js';
import { symlinkAliasWarning } from '../entities/warnings.js';
import type { Warning } from '../entities/warnings.js';

/**
 * Per-file drift verdict. `clean` means disk matches the expected projection.
 * `aliased` (#35) means the path resolves through an in-repo symlink onto
 * another repo path, so it is not audited at all (and apply will not write
 * it): comparing through the alias would diff the symlink's TARGET — on real
 * repos the canonical source — against the projection and report perpetual
 * bogus drift. `aliased` is not drift; it surfaces as HH-W013 (exit 2).
 */
export type DriftStatus =
  | 'clean'
  | 'drift:edited'
  | 'drift:stale'
  | 'drift:missing'
  | 'drift:unmanaged'
  | 'drift:differs'
  | 'aliased';

export interface FileAudit {
  /** Repo-relative POSIX path of the emitted target. */
  path: string;
  providerId: ProviderId;
  status: DriftStatus;
  /**
   * For merge-key files, the owned key (e.g. `hooks`, `context.fileName`);
   * absent for fully-owned files.
   */
  mergeKey?: string;
}

export interface AuditReport {
  /** One entry per expected emitted file, in projection order. */
  files: FileAudit[];
  /** Parse warnings + every adapter's projection warnings, concatenated. */
  warnings: Warning[];
  /** True when any file's status is not `clean` (`aliased` excepted — #35). */
  drift: boolean;
  /** PRD §7: 0 clean · 1 drift · 2 lossy-warning · 3 invalid config. */
  exitCode: 0 | 1 | 2 | 3;
}

export interface AuditDeps {
  /** Parses the canonical sources into IR + parse warnings (DI from layer 4). */
  parse: () => Promise<{ ir: IR; warnings: Warning[] }>;
  /** Enabled adapters, already filtered by config (`providers_disabled`). */
  adapters: readonly ProviderAdapter[];
  /** Read-only disk access for adapter merge decisions and drift comparison. */
  reader: ProviderFileReader;
  /** Per-provider projection context factory (cwd, providerConfig, reader). */
  contextFor: (id: ProviderId) => ProjectionContext;
  /**
   * #35: resolves a provider path that traverses an in-repo symlinked parent
   * to its real repo location (or null for a symlink-free path). Wired from
   * `createSymlinkAliasProbe` at the composition root; defaults to "never
   * aliased" for in-memory tests.
   */
  aliasOf?: (path: string) => string | null;
  /** `--strict` or config `warningsAsErrors`: escalate any warn to exit 1. */
  strict?: boolean;
  /**
   * #43: exit-code policy for the lossy-warning case (PRD §7 exit 2).
   *   - `'warn'` (default): a standing `HH-Wxxx` warning exits 2 (and exits 1
   *     under `--strict`) — the historical behavior.
   *   - `'drift'`: ONLY real drift (1) or invalid config (3) fail; a
   *     warnings-only run exits 0 (the warnings still print). This lets the CI
   *     template match the pre-commit hook, which already tolerates exit 2 —
   *     so a permanent, unfixable W001/W007 no longer wedges a drift-free repo's
   *     CI. `'drift'` de-escalates warnings even when `--strict` is also set.
   */
  failOn?: 'warn' | 'drift';
}

function statusToDrift(status: VerifyStatus): DriftStatus {
  switch (status) {
    case 'clean':
      return 'clean';
    case 'edited':
      return 'drift:edited';
    case 'stale':
      return 'drift:stale';
    case 'unmanaged':
      return 'drift:unmanaged';
  }
}

/** CRLF-insensitive full-content equality (matches SignedSource body hashing). */
function contentEquals(a: string, b: string): boolean {
  return a.replace(/\r\n/g, '\n') === b.replace(/\r\n/g, '\n');
}

function auditOverwriteFile(file: EmittedFile, reader: ProviderFileReader): DriftStatus {
  const disk = reader.read(file.path);
  if (disk === null) {
    return 'drift:missing';
  }
  // The freshly-projected body is the source of truth. When it carries a
  // SignedSource header (first-line for overwrite targets like copilot-
  // instructions.md, after-frontmatter for SKILL.md / .instructions.md /
  // .claude/rules), delegate the four-state verdict to the entity, which
  // detects placement, treats EOL-insensitive byte equality as 'clean', and
  // otherwise classifies unmanaged / edited / stale against the embedded
  // hashes (PRD §9 v0.3.1).
  if (detectHeaderPlacement(file.body) !== 'none') {
    return statusToDrift(verifyAgainstExpected(disk, file.body).status);
  }
  // Headerless owned file (JSON, verbatim attachment): no header to verify, so
  // full-content comparison decides. A byte-for-byte (EOL-insensitive) match
  // is clean; anything else is drift. edited vs stale are indistinguishable
  // here (PRD §9 carve-out 2 → C2 design note); any difference is drift.
  if (contentEquals(disk, file.body)) {
    return 'clean';
  }
  return 'drift:differs';
}

/** Resolves a dot-path (`context.fileName`) against a parsed JSON object. */
function resolveOwnedValue(
  root: Record<string, unknown>,
  mergeKey: string,
): { found: boolean; value: unknown } {
  const segments = mergeKey.split('.');
  let current: unknown = root;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object' || Array.isArray(current)) {
      return { found: false, value: undefined };
    }
    const obj = current as Record<string, unknown>;
    if (!(segment in obj)) {
      return { found: false, value: undefined };
    }
    current = obj[segment];
  }
  return { found: true, value: current };
}

/** Order-insensitive structural deep-equality for JSON values. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) {
    return true;
  }
  if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) {
      return false;
    }
    return a.every((item, i) => deepEqual(item, b[i]));
  }
  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) {
    return false;
  }
  return aKeys.every((key) => key in bObj && deepEqual(aObj[key], bObj[key]));
}

function auditMergeKeyFile(file: EmittedFile, reader: ProviderFileReader): DriftStatus {
  const disk = reader.read(file.path);
  if (disk === null) {
    // The FILE itself is absent — `drift:missing` is accurate (and is what the
    // absent-provider hint keys on to mean "no presence on disk", #43/gauntlet).
    return 'drift:missing';
  }
  // The merge-key file's body is the JSON of *only* the owned value (the
  // adapter renders `JSON.stringify(ownedValue, …)`). Parse both and compare
  // the owned key. A disk file whose owned key is absent drifts — audit never
  // writes, so it does not attempt a merge.
  //
  // Note: for providers that pre-read the co-owned file during projection
  // (claude/gemini read `.claude`/`.gemini/settings.json` to merge), a
  // syntactically malformed file surfaces earlier as MalformedProviderConfigError
  // (exit 3) from `project()`, before this verifier runs. The unparseable-disk
  // branch below is the backstop for any merge-key emit whose adapter does not
  // pre-read.
  let diskJson: unknown;
  try {
    diskJson = JSON.parse(disk);
  } catch {
    return 'drift:differs';
  }
  if (diskJson === null || typeof diskJson !== 'object' || Array.isArray(diskJson)) {
    return 'drift:differs';
  }
  const mergeKey = file.mergeKey ?? '';
  const { found, value } = resolveOwnedValue(diskJson as Record<string, unknown>, mergeKey);
  if (!found) {
    // The file EXISTS but lacks the owned key — that is divergence, not a
    // missing file (gauntlet, Codex+Thermos). Reporting `drift:missing` here
    // made the absent-provider hint falsely claim e.g. Gemini "has no files"
    // when the user keeps their own `.gemini/settings.json` without
    // `context.fileName`. `apply` will merge the key in → `drift:differs`.
    return 'drift:differs';
  }
  const expected = JSON.parse(file.body) as unknown;
  return deepEqual(value, expected) ? 'clean' : 'drift:differs';
}

export async function audit(deps: AuditDeps): Promise<AuditReport> {
  const { ir, warnings: parseWarnings } = await deps.parse();

  const files: FileAudit[] = [];
  const warnings: Warning[] = [...parseWarnings];
  const aliasOf = deps.aliasOf ?? (() => null);
  const aliasWarned = new Set<string>();

  for (const adapter of deps.adapters) {
    const projection = adapter.project(ir, deps.contextFor(adapter.id));
    warnings.push(...projection.warnings);
    for (const file of projection.files) {
      // #35: a path behind an in-repo symlinked parent is not audited —
      // reading through the alias would diff the symlink's target (the
      // canonical source) against the projection and report bogus drift
      // forever. Mirror of apply's skip, so apply→audit stays idempotent.
      const resolved = aliasOf(file.path);
      if (resolved !== null) {
        files.push({ path: file.path, providerId: adapter.id, status: 'aliased' });
        if (!aliasWarned.has(file.path)) {
          aliasWarned.add(file.path);
          warnings.push(symlinkAliasWarning(file.path, resolved, adapter.id));
        }
        continue;
      }
      const status =
        file.mode === 'merge-key'
          ? auditMergeKeyFile(file, deps.reader)
          : auditOverwriteFile(file, deps.reader);
      const entry: FileAudit = { path: file.path, providerId: adapter.id, status };
      if (file.mergeKey !== undefined) {
        entry.mergeKey = file.mergeKey;
      }
      files.push(entry);
    }
  }

  // `aliased` is excluded: it is "cannot manage" (warned via HH-W013), not a
  // divergence between disk and projection.
  const drift = files.some((file) => file.status !== 'clean' && file.status !== 'aliased');
  const hasWarnings = warnings.length > 0;
  const strictFail = deps.strict === true && hasWarnings;
  // #43: `--fail-on drift` makes a warnings-only run a non-failure (exit 0). It
  // overrides --strict's escalation too — the user has explicitly asked that
  // only drift fail — so both warning branches below are gated off in that mode.
  const failOnDriftOnly = deps.failOn === 'drift';

  // PRD §7 precedence: drift (1) beats lossy warnings (2) beats clean (0).
  // --strict / warningsAsErrors escalate warnings to a drift-equivalent 1,
  // unless `--fail-on drift` de-escalates them to 0.
  let exitCode: 0 | 1 | 2 | 3;
  if (drift || (strictFail && !failOnDriftOnly)) {
    exitCode = 1;
  } else if (hasWarnings && !failOnDriftOnly) {
    exitCode = 2;
  } else {
    exitCode = 0;
  }

  return { files, warnings, drift, exitCode };
}
