// Responsibility: every finding code `nuka run` prints that `nuka check`
// does not, each with its severity, the description `nuka check --codes`
// prints, and the edit that gets past it. Boundary: data only; the run
// raises them, and a check code it reuses (a pattern that did not build)
// stays in src/check/codes.ts.

export type RunSeverity = "failed" | "warning";

export interface RunCodeInfo {
  readonly severity: RunSeverity;
  readonly description: string;
  readonly fix: string;
}

const RUN_CODES = {
  "emitter-failed": {
    severity: "warning",
    description: "The Allure or the messages emitter could not write part of its output; the run and its records are not affected.",
    fix: "Correct what the message names, such as the output directory's permissions, and run again.",
  },
  "explore-error": {
    severity: "failed",
    description: "nuka experimental explore stopped on an error in the model or the relation itself, not in a step.",
    fix: "Correct the model or the relation code the message names.",
  },
  "explore-failed": {
    severity: "failed",
    description: "nuka experimental explore found a sequence of steps that fails; the shrunk scenario is on stdout.",
    fix: "Name the scenario on stdout, add it to a feature file, and correct the step or the code under test.",
  },
  "fixture-teardown-failed": {
    severity: "warning",
    description: "A fixture's teardown threw after its scenario or the run finished.",
    fix: "Correct the teardown code of the fixture the message names.",
  },
  "hook-failed": {
    severity: "failed",
    description: "A BeforeAll or AfterAll hook threw, so the run is red.",
    fix: "Correct the hook the message names.",
  },
  "record-unmatched": {
    severity: "warning",
    description: "A worker reported a record that matches no selected scenario, so the messages stream leaves it out.",
    fix: "Run again without changing feature files while the run is in progress.",
  },
  "retention-failed": {
    severity: "warning",
    description: "The run finished, and removing old run directories under retention failed.",
    fix: "Correct what the message names, such as a directory's permissions; the next run tries again.",
  },
  "run-incomplete": {
    severity: "failed",
    description: "A signal or a worker that exited early stopped the run before every scenario had a record.",
    fix: "Run the scenarios again; the message names what stopped the run.",
  },
  "run-result-not-written": {
    severity: "warning",
    description: "The run finished, and run.json could not be written.",
    fix: "Correct what the message names, such as the state directory's permissions.",
  },
  "scenario-failed": {
    severity: "failed",
    description: "A scenario ran and failed; its step lines and its record say which step and why.",
    fix: "Correct the step or the code under test that the error names.",
  },
  "summary-not-written": {
    severity: "warning",
    description: "The run finished, and a summary file could not be written.",
    fix: "Correct what the message names, such as the summary path's directory.",
  },
  "trace-version-unknown": {
    severity: "warning",
    description: "A Playwright trace has a version nukadoko cannot read, so its actions are not in the step record.",
    fix: "Install the Playwright version nukadoko is tested against.",
  },
  "version-probe-failed": {
    severity: "warning",
    description: "The environment's version probe did not answer, so the records have no target version.",
    fix: "Correct the environment's version setting in the config file, or the endpoint it names.",
  },
  "world-setup-failed": {
    severity: "warning",
    description: "A compat World could not be set up for a scenario.",
    fix: "Correct the World class or the defineWorld call the message names.",
  },
  "worker-output-unreadable": {
    severity: "warning",
    description: "A worker under --concurrency wrote a line on its stdout that is not one of its messages.",
    fix: "Remove the code that writes to process.stdout from the step files or the code they import.",
  },
} as const satisfies Record<string, RunCodeInfo>;

export type RunCode = keyof typeof RUN_CODES;

export function isRunCode(code: string): code is RunCode {
  return Object.hasOwn(RUN_CODES, code);
}

export function runCodeInfo(code: RunCode): RunCodeInfo {
  return RUN_CODES[code];
}

/** Every run code, in code-ascending order. */
export function listRunCodes(): ReadonlyArray<{ code: RunCode } & RunCodeInfo> {
  return (Object.keys(RUN_CODES) as RunCode[])
    .sort((a, b) => a.localeCompare(b))
    .map((code) => ({ code, ...RUN_CODES[code] }));
}
