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

/** Thrown when a feature file exists but cannot be read (permission
 * denied, a file used as a directory). Calling that "not found" sends the
 * reader looking for a file that is right there, so the system error's own
 * text is kept. */
export class FeatureReadFailedError extends Error {
  readonly relativePath: string;

  constructor(relativePath: string, cause: unknown) {
    super(`Failed to read feature file "${relativePath}": ${cause instanceof Error ? cause.message : String(cause)}`, {
      cause,
    });
    this.name = "FeatureReadFailedError";
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
 * gherkin `location.line` matching it. */
export class NoMatchingScenarioError extends Error {
  readonly relativePath: string;
  readonly line: number;
  /** The lines that do select a pickle, read from the parsed file, so the
   * refusal names a line that works rather than pointing at `--help`. */
  readonly do: string;

  constructor(relativePath: string, line: number, scenarioLines: readonly number[]) {
    super(`No scenario found at ${relativePath}:${line}`);
    this.name = "NoMatchingScenarioError";
    this.relativePath = relativePath;
    this.line = line;
    this.do =
      scenarioLines.length === 0
        ? `Add a scenario to ${relativePath}; nothing in it can run yet.`
        : `Name a line a scenario or an Examples row starts on: ${scenarioLines.join(", ")}.`;
  }
}

/** Thrown when a directory target also carries a `:line` suffix — `:line`
 * selects one pickle inside a single file's own gherkin `location.line`, and
 * a directory names no single file for that to mean anything against. */
export class DirectoryTargetLineError extends Error {
  readonly relativePath: string;
  readonly line: number;
  /** Every target as given, except that each directory loses its `:line`:
   * the run the caller can start instead, since a directory target runs
   * every scenario under it. */
  readonly targetsWithoutLine: readonly string[];

  constructor(relativePath: string, line: number, targetsWithoutLine: readonly string[]) {
    super(
      `":line" has no meaning for a directory: ${relativePath}:${line} names a directory, not a feature file`,
    );
    this.name = "DirectoryTargetLineError";
    this.relativePath = relativePath;
    this.line = line;
    this.targetsWithoutLine = targetsWithoutLine;
  }
}

/** Thrown when a directory target's own recursive walk finds zero
 * `.feature` files anywhere under it — the same "name exactly what it
 * looked at" tone `nuka check`'s own `no-step-files-found` uses
 * (src/check/analyze.ts), so a run that would do nothing refuses loudly
 * instead of exiting 0 having run nothing at all. */
export class NoFeatureFilesFoundError extends Error {
  readonly relativePath: string;
  readonly resolvedPath: string;
  readonly do: string;

  constructor(
    scannedPaths: readonly string[],
    resolvedPath: string,
    consideredOaths = false,
    oathDirectory = false,
  ) {
    const relativePath = scannedPaths.join('" and "');
    super(
      oathDirectory
        ? `no Markdown file was found while scanning "${relativePath}" (resolved to ${resolvedPath}); nothing can run`
        : consideredOaths
        ? `no .feature file or configured oath was found while scanning "${relativePath}" (resolved to ${resolvedPath}); nothing can run`
        : `no .feature file was found while scanning "${relativePath}" (resolved to ${resolvedPath}); nothing can run`,
    );
    this.name = "NoFeatureFilesFoundError";
    this.relativePath = relativePath;
    this.resolvedPath = resolvedPath;
    this.do = `Add a ${oathDirectory ? "Markdown" : ".feature"} file under ${scannedPaths.join(" or ")}.`;
  }
}
