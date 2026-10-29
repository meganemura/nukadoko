// Responsibility: every finding code `nuka run` (and `nuka report`,
// `nuka steps`, and `nuka describe`, which read what a run or a step file
// holds, `nuka step`, which reads a walk, and `nuka clean`, which keeps a
// walk's run) prints that `nuka check` does not, each with its severity, the description `nuka check --codes`
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
  "base-feature-unparsed": {
    severity: "warning",
    description:
      "Under nuka run --base, the base's copy of a feature file does not parse, so its criteria were not compared with head's and each counts as new.",
    fix: "Nothing needs changing at head. Each criterion of the file is judged as new, so its base cell has to show a Then failing; to compare them with the base, name a base whose copy of the file parses.",
  },
  "claim-judged-early": {
    severity: "failed",
    description:
      "A claim on a count of execution events was judged before every line it counts had arrived: the world's stop counted every line of the producer's trace, and the whole count judges the claim otherwise, so its cell is broke and proves nothing.",
    fix: 'Have the program write a request\'s line after the work inside it, and run work that outlives the request as a job, which a reading waits for (docs/execution-events.md "Inside first").',
  },
  "contract-unreadable": {
    severity: "failed",
    description:
      "nuka steps --json or nuka describe could not read part of a step's contract: its needs, a from entry, or an args or returns schema that JSON Schema cannot represent. The rest is printed, and the command exits 1.",
    fix: "Correct what the message names in the step file; a schema JSON Schema cannot represent, such as z.date(), still runs, and only its published contract is missing.",
  },
  "criterion-moved": {
    severity: "failed",
    description:
      "Under nuka run --base, an unchanged criterion passes at head, its mapping or its tags changed since the base, and the old world, head's code under the base's feature files and mapping, did not pass it or could not run it: the approved sentence no longer holds under the steps it was approved with.",
    fix: "Restore what the changed step, helper, or tag did, so the base's steps still pass on head's code, or correct what kept the old world from running, which the message names; a sentence that should now mean something else is edited, which makes it a changed criterion to prove.",
  },
  "criterion-unproven": {
    severity: "failed",
    description:
      "Under nuka run --base, a new or changed criterion passes at head, and nothing shows a Then failing where its behaviour is absent: its base cells passed, broke, were flaky, failed in fewer than --proof-runs runs, or did not run, and no control proves it.",
    fix: "Make a Then claim what the change added, so that it fails on the base's code; tag the scenario @held when the base already has the behaviour; or correct what kept its base cell from running, which the message names.",
  },
  "criterion-without-required-cell": {
    severity: "failed",
    description:
      "A row of the verdict table has no required cell: no environment the run started meets every condition its scenario's tags name, so the row is failed and nothing ran that shows it holds. Only a run under --no-check reaches it; nuka check reports the scenario as condition-unmet.",
    fix: "Add an environment whose conditions meet the scenario's tags, run one that does with --env, or correct the tags.",
  },
  "events-late": {
    severity: "note",
    description:
      "nuka do found lines of the program's execution events that carry the step's trace id and arrived after the step ended, when the world stopped. They are in events-late.jsonl beside the step record, and are not in its observed.events.",
    fix: "No change is necessary. A job the step enqueued that performed after the step ended writes its lines then; observed.events.open names a job that had not performed.",
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
  "nothing-selected": {
    severity: "failed",
    description:
      "nuka run selected no scenario: its targets hold none, or --env leaves out every one they hold, so nothing ran and nothing was checked. The run writes no run directory.",
    fix: "Name a target that holds a scenario, or run in an environment that meets the scenarios' tags.",
  },
  "program-exited": {
    severity: "warning",
    description: "The program a world served exited while the scenarios still ran, so the requests after that found nothing listening.",
    fix: "Read the world's program.log, which the message names, for why the program exited.",
  },
  "program-log-late": {
    severity: "note",
    description:
      "nuka do found lines of the program's log that carry the step's trace id and arrived after the step ended, when the world stopped. They are in program-log-late.txt beside the step record, and are not in its observed.program_log.",
    fix: "No change is necessary. When it happens on every call, the program may buffer its output on a pipe; if so, set STDOUT.sync = true in Ruby, or PYTHONUNBUFFERED=1 for Python.",
  },
  "program-start-failed": {
    severity: "failed",
    description:
      "The program in nukadoko.program.ts did not start for a world: a build or prepare command failed or did not finish within its timeout_ms, the server did not answer its ready path in time, or setup or the url function threw or did not finish within its timeout_ms. The world's scenarios did not run.",
    fix: "Correct what the message names; the end of the world's program.log is in the message, and the whole file is in the world's directory.",
  },
  "proof-run-incomplete": {
    severity: "warning",
    description:
      "Under --concurrency, a proof round could not record a control's run: a BeforeAll or AfterAll hook failed in the worker the round started, or the worker exited without a record. Each control cell the round was given reads broke with the reason and proves nothing, so its row reads as one no control proves: held without --base, and under --base the base world runs for it.",
    fix: "Correct what the message names, such as the hook; the control proves on the next run.",
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
  "show-requests-failed": {
    severity: "warning",
    description: "showRequests could not draw a request on its page, so no requests trace was written. http.jsonl still has every request.",
    fix: "Correct what the message names, such as a browser that is not installed (npx playwright install chromium), or turn showRequests off.",
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
  "walk-gone": {
    severity: "failed",
    description:
      "nuka step found a walk whose nuka run --step process ended without recording how: it was killed, or it crashed, so its world, its browser, and its fixtures may not have been torn down.",
    fix: "Stop what the walk left running, if anything, and start the walk again with the command the finding names.",
  },
  "walk-failed": {
    severity: "failed",
    description:
      "nuka step found the walk paused after a step that failed, or after a step whose AfterStep hook failed: the scenario is failed, and the pause names which of them failed and its message. The walk still waits for its answer, and nothing is left to stop.",
    fix: "Show the person the failure and the pause's views, answer next when they have seen it, and read the step record for the cause.",
  },
  "walk-run-kept": {
    severity: "note",
    description:
      "nuka clean kept a run directory because a walk (nuka run --step) that is live writes there, and nuka step answers its pauses through it. While a walk is starting, every run directory with no run.json is kept, since its run may have made one already.",
    fix: "Run nuka clean again once the walk ended; nuka step wait --walk <n> reports when it does.",
  },
  "walk-stopped": {
    severity: "failed",
    description:
      "A walk (nuka run --step) was stopped at a pause with nuka step stop, so the steps after it did not run and nothing shows the scenario holds. The scenario is stopped, not failed, and its row is red.",
    fix: "Run the scenario without --step, or walk it to its last step, for a run that shows it holds.",
  },
  "world-setup-failed": {
    severity: "warning",
    description: "A compat World could not be set up for a scenario.",
    fix: "Correct the World class or the defineWorld call the message names.",
  },
  "worker-output-unreadable": {
    severity: "warning",
    description: "A worker, under --concurrency or in a tree of nuka run --base, wrote a line on its stdout that is not one of its messages.",
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
