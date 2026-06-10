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
