// Responsibility: the error types session handling raises on its own (as
// opposed to fs errors that propagate as-is). Kept separate from the modules
// that throw them (name.ts, lock.ts, store.ts, manage.ts) so callers (do.ts,
// cli/session.ts, tests) can `instanceof` them without pulling in fs/crypto
// dependencies — same convention as config/errors.ts and discover/errors.ts.

export class InvalidSessionNameError extends Error {
  readonly sessionName: string;

  constructor(sessionName: string) {
    super(`Invalid session name "${sessionName}": must match [a-z0-9_-]+`);
    this.name = "InvalidSessionNameError";
    this.sessionName = sessionName;
  }
}

export class SessionLockConflictError extends Error {
  readonly sessionName: string;
  readonly pid: number;

  constructor(sessionName: string, pid: number) {
    super(`Session "${sessionName}" is locked by another process (pid ${pid})`);
    this.name = "SessionLockConflictError";
    this.sessionName = sessionName;
    this.pid = pid;
  }
}

export class MalformedSessionFileError extends Error {
  readonly sessionName: string;

  constructor(sessionName: string, cause: unknown) {
    super(
      `Session "${sessionName}" file is not valid JSON: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "MalformedSessionFileError";
    this.sessionName = sessionName;
  }
}

export class SessionNotFoundError extends Error {
  readonly sessionName: string;

  constructor(sessionName: string) {
    super(`Session "${sessionName}" not found`);
    this.name = "SessionNotFoundError";
    this.sessionName = sessionName;
  }
}
