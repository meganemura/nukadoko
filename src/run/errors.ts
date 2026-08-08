// Responsibility: the error types `nuka run`'s setup phase raises on its own
// (as opposed to fs/gherkin errors that propagate as-is via their own
// `cause`). Kept separate from the module that throws them
// (select-pickles.ts) so callers (cli/run.ts, tests) can `instanceof` them
// without pulling in that module's fs/gherkin dependencies — same
// convention as config/errors.ts, discover/errors.ts, session/errors.ts,
// environment/errors.ts.

export class FeatureFileNotFoundError extends Error {
  readonly relativePath: string;

  constructor(relativePath: string) {
    super(`Feature file not found: ${relativePath}`);
    this.name = "FeatureFileNotFoundError";
    this.relativePath = relativePath;
  }
}

export class FeatureParseFailedError extends Error {
  readonly relativePath: string;

  constructor(relativePath: string, cause: unknown) {
    super(
      `Failed to parse feature file "${relativePath}": ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = "FeatureParseFailedError";
    this.relativePath = relativePath;
  }
}

/** Thrown when `:line` was given explicitly but no pickle in the file has a
 * gherkin `location.line` matching it (this task's spec, decision 1: zero
 * matches is a setup failure). */
export class NoMatchingScenarioError extends Error {
  readonly relativePath: string;
  readonly line: number;

  constructor(relativePath: string, line: number) {
    super(`No scenario found at ${relativePath}:${line}`);
    this.name = "NoMatchingScenarioError";
    this.relativePath = relativePath;
    this.line = line;
  }
}

/** Thrown when a directory target (run-directory-target task spec, decision
 * 4) also carries a `:line` suffix — `:line` selects one pickle inside a
 * single file's own gherkin `location.line`, and a directory names no single
 * file for that to mean anything against. */
export class DirectoryTargetLineError extends Error {
  readonly relativePath: string;
  readonly line: number;

  constructor(relativePath: string, line: number) {
    super(
      `":line" has no meaning for a directory: ${relativePath}:${line} names a directory, not a feature file`,
    );
    this.name = "DirectoryTargetLineError";
    this.relativePath = relativePath;
    this.line = line;
  }
}

/** Thrown when a directory target's own recursive walk (run-directory-target
 * task spec, decision 3) finds zero `.feature` files anywhere under it — the
 * same "name exactly what it looked at" tone `nuka check`'s own
 * `no-step-files-found` uses (src/check/analyze.ts), so a run that would do
 * nothing refuses loudly instead of exiting 0 having run nothing at all. */
export class NoFeatureFilesFoundError extends Error {
  readonly relativePath: string;
  readonly resolvedPath: string;

  constructor(relativePath: string, resolvedPath: string) {
    super(
      `no .feature file was found while scanning "${relativePath}" (resolved to ${resolvedPath}); nothing can run`,
    );
    this.name = "NoFeatureFilesFoundError";
    this.relativePath = relativePath;
    this.resolvedPath = resolvedPath;
  }
}
