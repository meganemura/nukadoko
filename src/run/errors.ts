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
 * gherkin `location.line` matching it (this task's spec, decision 1: "一致
 * ゼロはセットアップ失敗"). */
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
