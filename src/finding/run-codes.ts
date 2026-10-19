// Responsibility: every finding code `nuka run` (and `nuka report`,
// `nuka steps`, and `nuka describe`, which read what a run or a step file
// holds) prints that `nuka check` does not, each with its severity, the description `nuka check --codes`
// prints, and the edit that gets past it. Boundary: data only; the run
// raises them, and a check code it reuses (a pattern that did not build)
// stays in src/check/codes.ts.

export type RunSeverity = "failed" | "warning" | "note";

export interface RunCodeInfo {
  readonly severity: RunSeverity;
  readonly description: string;
  readonly fix: string;
}

const RUN_CODES = {
  "contract-unreadable": {
    severity: "failed",
    description:
      "nuka steps --json or nuka describe could not read part of a step's contract: its needs, a from entry, or an args or returns schema that JSON Schema cannot represent. The rest is printed, and the command exits 1.",
    fix: "Correct what the message names in the step file; a schema JSON Schema cannot represent, such as z.date(), still runs, and only its published contract is missing.",
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
    description: "A worker reported a record that matches no selected scenario, so nuka report cannot render it.",
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
  "report-incomplete": {
    severity: "failed",
    description: "nuka report left out part of the run it renders: a scenario, a step record, or an attachment it could not read or map. The rest is written, and the report exits 1.",
    fix: "Correct what the message names, such as a step record removed from the run directory, and run nuka report again.",
  },
  "run-result-not-written": {
    severity: "failed",
    description: "The run finished, and run.json could not be written, so the run fails: it has no record for a later command to read.",
    fix: "Correct what the message names, such as the state directory's permissions.",
  },
  "run-sources-not-written": {
    severity: "failed",
    description: "The run finished, and sources.json, the feature text nuka report renders the run from, could not be written, so the run fails.",
    fix: "Correct what the message names, such as the state directory's permissions, and run again.",
  },
  "scenario-failed": {
    severity: "failed",
    description: "A scenario ran and failed; its step lines and its record say which step and why.",
    fix: "Correct the step or the code under test that the error names.",
  },
  "step-record-unreadable": {
    severity: "warning",
    description: "A step wrote a step record that could not be read back, so run.json and the summary have no declaration or measurement for it.",
    fix: "Correct what the message names, such as a full disk or a process that removed the run directory during the run.",
  },
  "summary-not-written": {
    severity: "warning",
    description: "The run finished, and a summary file could not be written.",
    fix: "Correct what the message names, such as the summary path's directory.",
  },
  "then-passed-with-changed-capture": {
    severity: "note",
    description:
      "Under nuka run --probe, a read-only Then passed again with one of its captures changed, so it may not compare that value.",
    fix: "Make the step compare its result with the capture the message names; a step whose sentence also allows the changed value, such as \"at least n\", can stay as it is.",
  },
  "then-probe-not-measured": {
    severity: "note",
    description:
      "Under nuka run --probe, a read-only Then was not re-run with a changed capture, or its re-run stopped before the step compared anything, so the probe says nothing about it.",
    fix: "Read the reason in the message: a step that wrote when it ran is not run again, and a re-run that wrote is not counted; an args schema that refuses the changed value, a fixture that failed, a timeout, or a returns schema that refuses the result is corrected where the message names, or the Then is left to review.",
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
