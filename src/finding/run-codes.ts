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
  "program-exited": {
    severity: "warning",
    description: "The program a world served exited while the scenarios still ran, so the requests after that found nothing listening.",
    fix: "Read the world's program.log, which the message names, for why the program exited.",
  },
  "program-start-failed": {
    severity: "failed",
    description: "The program in nukadoko.program.ts did not start for a world: a build or prepare command failed, the server did not answer its ready path in time, or setup threw. The world's scenarios did not run.",
    fix: "Correct what the message names; the end of the world's program.log is in the message, and the whole file is in the world's directory.",
  },
  "record-unmatched": {
    severity: "warning",
    description: "A worker reported a record that matches no selected scenario, so nuka report cannot render it.",
    fix: "Run again without changing feature files while the run is in progress.",
  },
  "repeated-scenario-prefix": {
    severity: "note",
    description:
      "Scenarios in this run open with the same steps, before the first When, with the same docstrings and tables. The note reports the measured repetition, and names a process-scope fixture only when every shared step declares mutates: false.",
    fix: "No change is necessary. A Background can hold the shared steps. A process-scope fixture fits only an opening whose steps all declare mutates: false.",
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
  "trace-version-unknown": {
    severity: "warning",
    description: "A Playwright trace has a version nukadoko cannot read, so its actions are not in the step record.",
    fix: "Install the Playwright version nukadoko is tested against.",
  },
  "version-probe-failed": {
    severity: "warning",
    description: "The environment's version probe did not answer, so the records have no target version.",
    fix: "Correct the environment's version setting in nukadoko.program.ts, or the endpoint it names.",
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
