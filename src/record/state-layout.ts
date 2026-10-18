import path from "node:path";

// Responsibility: where each kind of measurement lives under the state
// directory, as paths relative to the project root. Pure; nothing here
// touches the file system.
//
// A `nuka run` invocation owns one directory, `<stateDir>/runs/<run_id>/`,
// and everything it measured is inside it: `run.json`, `summary.md`, the
// exports manifest, `steps/<step_record_id>/` for each step record, and
// `scenarios/<scenario_record_id>/` for a scenario that wrote evidence of
// its own. One directory is what CI uploads, what an auditor downloads,
// and what retention and `nuka clean` remove, so none of them has to join
// files by id to learn what a run owns. A `nuka do` call belongs to no run,
// so its step records sit apart, under `<stateDir>/do/<step_record_id>/`.
//
// The alternative refused: keeping one `records/steps/` for both, with the
// run id inside each record. That kept every reader that walks one run
// scanning every step record of every run, and made a run's files leave
// together only through a rule that reads each record first.

export const RUN_FILE_DIRS = { steps: "steps", scenarios: "scenarios" } as const;

/** `<stateDir>/runs`, the parent of every run directory. */
export function runsRelativeDir(stateDir: string): string {
  return path.join(stateDir, "runs");
}

/** `<stateDir>/runs/<run_id>`, one `nuka run` invocation's own directory. */
export function runRelativeDir(stateDir: string, runId: string): string {
  return path.join(runsRelativeDir(stateDir), runId);
}

/** `<stateDir>/export`, where `nuka report` writes by default. */
export function exportRelativeDir(stateDir: string): string {
  return path.join(stateDir, "export");
}

/** `<stateDir>/export/allure-results`, where `nuka report --format allure`
 * writes without `--out`, the directory `nuka init --allure` creates, and
 * the one directory under `export/` that `nuka clean` empties whole. */
export function allureResultsRelativeDir(stateDir: string): string {
  return path.join(exportRelativeDir(stateDir), "allure-results");
}

/** `<stateDir>/do`, the parent of every `nuka do` step record. */
export function doRelativeDir(stateDir: string): string {
  return path.join(stateDir, "do");
}

/** The directory a step record is written to: inside its run's `steps/`,
 * or under `do/` for a step that ran outside any run (`runId` `null`). */
export function stepRecordRelativeDir(stateDir: string, runId: string | null, stepRecordId: string): string {
  return runId === null
    ? path.join(doRelativeDir(stateDir), stepRecordId)
    : path.join(runRelativeDir(stateDir, runId), RUN_FILE_DIRS.steps, stepRecordId);
}

/** The directory a scenario's own evidence is written to, inside its run. */
export function scenarioRelativeDir(stateDir: string, runId: string, scenarioRecordId: string): string {
  return path.join(runRelativeDir(stateDir, runId), RUN_FILE_DIRS.scenarios, scenarioRecordId);
}

/** A path inside a run directory, as run.json names it: relative to the
 * run directory, so a run directory reads the same after it is moved or
 * downloaded. `relativePath` is project-root-relative. */
export function relativeToRun(stateDir: string, runId: string, relativePath: string): string {
  return path.relative(runRelativeDir(stateDir, runId), relativePath);
}

/** Where a path a record names lies on disk once its run directory is at
 * `runDir`. A record names its files relative to the project root
 * (`<stateDir>/runs/<run_id>/...`), so a run directory copied off a CI
 * machine would point back into a project that is not there. The first
 * `runs/<run_id>` pair in the path marks where the run directory starts;
 * a path without one is not inside the run and resolves against `rootDir`.
 * Pure: `runDir` and `rootDir` are joined, never read. */
export function resolveRecordedPath(recorded: string, runId: string, runDir: string, rootDir: string): string {
  const segments = recorded.split(/[\\/]/);
  for (let index = 0; index + 1 < segments.length; index += 1) {
    if (segments[index] === "runs" && segments[index + 1] === runId) {
      return path.join(runDir, ...segments.slice(index + 2));
    }
  }
  return path.resolve(rootDir, recorded);
}

/** Whether `child` lies strictly inside `parent`, both resolved by
 * `path.relative` alone (no symlink is read). A name that only starts with
 * two dots, such as `..foo`, is inside: only `..` itself, or `..` followed
 * by a separator, leaves. Pure; the one test every caller that removes or
 * reads a path by this rule shares. */
export function isInsideDir(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && !path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`);
}
