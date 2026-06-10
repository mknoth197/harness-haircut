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

/** Two adapters registered the same provider id (F3 UN1 — an internal wiring bug). */
export class DuplicateAdapterError extends DomainError {
  readonly providerId: string;

  constructor(providerId: string) {
    super(`adapter id "${providerId}" is already registered`, 70);
    this.providerId = providerId;
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
