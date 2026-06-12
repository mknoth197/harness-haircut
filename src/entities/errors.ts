/**
 * Typed domain errors. Use cases throw these — never raw `Error` — and the
 * composition root translates `exitCode` per PRD §7.
 */

export abstract class DomainError extends Error {
  /** Process exit code per PRD §7 (3 = invalid config/canonical input, 70 = internal). */
  readonly exitCode: number;

  protected constructor(message: string, exitCode: number, options?: ErrorOptions) {
    super(message, options);
    this.name = new.target.name;
    this.exitCode = exitCode;
  }
}

/** A canonical source file could not be parsed (F1 UN2–UN5; exit code 3). */
export class ParseError extends DomainError {
  readonly filePath: string;
  readonly reason: string;

  constructor(filePath: string, reason: string) {
    super(`${filePath}: ${reason}`, 3);
    this.filePath = filePath;
    this.reason = reason;
  }
}

/**
 * Several canonical source files failed to parse in one pass (#36; exit
 * code 3, same contract as a single `ParseError`). `parseRepo` collects every
 * per-file `ParseError` before failing so a repo with multiple bad files is
 * fixed in one round instead of one error per run; the message lists them all.
 */
export class AggregateParseError extends DomainError {
  readonly errors: readonly ParseError[];

  constructor(errors: readonly ParseError[]) {
    super(
      `${errors.length} canonical source files failed to parse:\n` +
        errors.map((error) => `  ${error.message}`).join('\n'),
      3,
    );
    this.errors = errors;
  }
}

/**
 * A SignedSource manifest entry path contains a newline (F2). Manifest lines
 * are `\n`-joined, so such a path would make the manifest ambiguous; callers
 * construct entries from walked repo paths, making this an internal bug.
 */
export class InvalidSourcePathError extends DomainError {
  readonly path: string;

  constructor(path: string) {
    super(`SignedSource manifest path contains a newline: ${JSON.stringify(path)}`, 70);
    this.path = path;
  }
}

/** Two adapters registered the same provider id (F3 UN1 — an internal wiring bug). */
export class DuplicateAdapterError extends DomainError {
  readonly providerId: string;

  constructor(providerId: string) {
    super(`adapter id "${providerId}" is already registered`, 70);
    this.providerId = providerId;
  }
}

/**
 * An existing co-owned provider config could not be parsed (A2 UN1, A3 UN1;
 * exit code 3). Adapters refuse to emit into a file they cannot merge with
 * rather than risking a silent overwrite of user content.
 */
export class MalformedProviderConfigError extends DomainError {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`${path}: ${reason}`, 3);
    this.path = path;
  }
}

/**
 * Two canonical sources flatten to the same emitted file path (A4 UN1;
 * exit code 3). Thrown before any emit so neither projection can silently
 * clobber the other; the fix is renaming one canonical source.
 */
export class EmitPathCollisionError extends DomainError {
  readonly targetPath: string;
  readonly sourcePaths: readonly [string, string];

  constructor(targetPath: string, sourceA: string, sourceB: string) {
    super(
      `two canonical sources project to the same file ${targetPath}: ${sourceA} and ${sourceB}`,
      3,
    );
    this.targetPath = targetPath;
    this.sourcePaths = [sourceA, sourceB];
  }
}

/**
 * `harness-haircut.config.json` is malformed or carries an invalid value
 * (C1 UN — invalid config; exit code 3). Distinct from
 * `MalformedProviderConfigError`, which covers a *provider's* co-owned file.
 */
export class InvalidConfigError extends DomainError {
  readonly path: string;

  constructor(path: string, reason: string) {
    super(`${path}: ${reason}`, 3);
    this.path = path;
  }
}

/**
 * A JSON merge-key dot-path contained a prototype-pollution segment
 * (`__proto__`, `constructor`, or `prototype`). The merge key is a constant
 * today, so this is a latent-defense guard: refusing such a path keeps the
 * dot-path setter from ever walking onto `Object.prototype` (exit code 3,
 * treated as an invalid-config / unsafe-input failure).
 */
export class UnsafeMergeKeyError extends DomainError {
  readonly mergeKey: string;
  readonly segment: string;

  constructor(mergeKey: string, segment: string) {
    super(
      `unsafe merge key ${JSON.stringify(mergeKey)}: segment ${JSON.stringify(segment)} ` +
        'is forbidden (prototype-pollution guard)',
      3,
    );
    this.mergeKey = mergeKey;
    this.segment = segment;
  }
}

/** An OS-level filesystem failure, converted at the gateway boundary. */
export class FileSystemError extends DomainError {
  readonly path: string;

  constructor(path: string, cause: unknown) {
    super(
      `filesystem error at ${path}: ${cause instanceof Error ? cause.message : String(cause)}`,
      70,
      { cause },
    );
    this.path = path;
  }
}
