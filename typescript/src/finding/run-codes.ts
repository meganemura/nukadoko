// Responsibility: every finding code `nuka run` (and `nuka report`,
// `nuka steps`, and `nuka describe`, which read what a run or a step file
// holds, `nuka step`, which reads a walk, `nuka clean`, which keeps a
// walk's run, and `nuka verdict`, which reads the newest run) prints that `nuka check` does not, each with its severity, the description `nuka check --codes`
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
  "expects-unseen": {
    severity: "note",
    description:
      "A scenario whose every execution passed carries an @expects: tag that matched nothing: the run saw every response, page error, or execution event of that kind in each execution, and none was the failure the tag accepts. A tag left in place accepts that failure in every later run.",
    fix: "Remove the tag when the failure it accepts no longer happens. When the failure is meant to happen, make the scenario cause it, so the tag names what the scenario does.",
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
  "intent-not-happening": {
    severity: "failed",
    description:
      "Under nuka run --base, a row of the change's INTENT.md aimed at a compared criterion, by its target, and that criterion did not do what the row says: a count did not go from before to after, a value did not, or what the row says does not change did. docs/intent.md is the format.",
    fix: "Make the change do what the row says there, or narrow the row's target if the row means less.",
  },
  "intent-unintended": {
    severity: "failed",
    description:
      "Under nuka run --base, the change declares its intent in INTENT.md, and an unchanged criterion did something at head that it did not do at the base, which no row of the intent declares. The summary's \"base → head\" lists the difference.",
    fix: "Declare the difference with a row in INTENT.md if the change means it, or change the code back if it does not.",
  },
  "intent-unread": {
    severity: "failed",
    description:
      "Under nuka run --base, the change's INTENT.md holds a row, or a table, that cannot be read as an intent, or git did not answer what the run asked of the file. A row that cannot be read declares nothing, so the run fails rather than judge less than the file says.",
    fix: "Write the row as docs/intent.md describes, so each difference the change means is declared.",
  },
  "judgment-misses": {
    severity: "failed",
    description:
      "A criterion's Then asks for a judgment, and the committed judgment that cites the value this run read says the value does not meet the sentence. The criterion fails until the value changes, and the judgment of the new value says it meets.",
    fix: "Change the program until the value meets the sentence, run the criterion again, and have a judge who did not write the change judge the new value with nuka judge.",
  },
  "judgment-pending": {
    severity: "failed",
    description:
      "A criterion's Then asks for a judgment (a judged-as claim), the run read the value, and no committed judgment cites that claim yet. nukadoko compares nothing for such a claim, so nothing shows the criterion holds until a reader judges the value.",
    fix: "Have a judge who did not write the change read the value with nuka judge <file>:<line> --run <run>, then record it with --meets or --misses, --by, and --because, commit the judgment file, and run again.",
  },
  "judgment-stale": {
    severity: "failed",
    description:
      "A criterion's Then asks for a judgment, and the committed judgments of its claim cite other values than the one this run read: the value changed since it was judged, so no judgment covers what ran.",
    fix: "Have a judge who did not write the change read the new value with nuka judge <file>:<line> --run <run> and record a judgment of it; a value that changes on every run (a time, an id) means the claim reads too much, so narrow it with at.",
  },
  "judgment-uncitable": {
    severity: "failed",
    description:
      "A criterion's Then asks for a judgment of a value that no channel nukadoko recorded holds (measured: none): a value step code wrote or worked out. A judgment cites only a value the tool measured, so none can cite this one.",
    fix: "Read the value whole from a channel the step record holds (a response body, a process's output, a file) and narrow it with view and at, or return the locator or page from observe so nukadoko takes its ARIA snapshot.",
  },
  "judgments-not-compared": {
    severity: "warning",
    description: "Under nuka run --base, git did not answer when the run compared the judgment files with the base, so the summary lists no changed judgment.",
    fix: "Run the git command the message names to see its error; the verdicts and the judgments themselves are not affected.",
  },
  "judgments-unread": {
    severity: "failed",
    description: "A judgment file under judgments/ does not parse or lacks a field, so the criteria of its feature file read as judged by nothing.",
    fix: "Repair the file the message names by hand, or remove it and judge its criteria again with nuka judge.",
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
  "program-list-unread": {
    severity: "warning",
    description:
      "A command under lists in nukadoko.program.ts failed, passed its limit, or printed a line that is not one entry of its list, so that world's list was not read and nothing of it counts.",
    fix: "Correct the command the message names, or what it prints: one JSON object per line, in the shape docs/spec.md \"Lists\" gives for its kind. Its stderr is in the world's program.log.",
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
  "run-missing": {
    severity: "failed",
    description: "nuka verdict found no run that ended in this project, so nothing judged the working tree.",
    fix: "Run the criteria the change touches with nuka run, under --base with the commit the change started from, and read the verdict table before nuka verdict.",
  },
  "run-partial": {
    severity: "failed",
    description:
      "nuka verdict found that the newest run left out scenarios of the files it named, with a :line target or --tag, or was a walk (nuka run --step), whose world was open to anything between steps. Such a run is for debugging or exploring, and does not judge the criteria.",
    fix: "Run the feature files again without :line, --tag, or --step.",
  },
  "run-stale": {
    severity: "failed",
    description:
      "nuka verdict found that the newest run judged another working tree than the one there is now: a tracked file, or an untracked file .gitignore does not leave out, changed after it started, or it recorded no working tree id. Its verdicts say nothing about the change since.",
    fix: "Run the criteria again on the tree as it is. When every run leaves the tree changed, a step or the program writes a file git counts: add that file to .gitignore.",
  },
  "run-failed": {
    severity: "failed",
    description: "nuka verdict found that the newest run failed, and its run.json holds no failed finding that says why.",
    fix: "Read the run summary that the do line renders for why the run failed.",
  },
  "run-without-base": {
    severity: "note",
    description:
      "nuka verdict found that the newest run had no --base, so no row of its table says which criteria are new or changed, and a new criterion that passes without the change was not caught as unproven.",
    fix: "No change is necessary. Run with --base and the commit the change started from to have new and changed criteria proven against it.",
  },
  "criteria-unchanged": {
    severity: "note",
    description:
      "nuka verdict found that, under --base, no criterion of the newest run is new or changed: the run shows the criteria that were there still hold, and says nothing of what the change was for.",
    fix: "No change is necessary for a change that needs no criterion of its own, such as a refactor. A change of behaviour gets a scenario that says what it does.",
  },
  "working-tree-unknown": {
    severity: "note",
    description:
      "nuka verdict could not get a git tree id for the working tree: outside a repository, before its first commit, or a git call failed. Whether the newest run judged this tree is unknown, so the verdict is that run's own table.",
    fix: "No change is necessary. In a git repository with a commit, nuka verdict compares the tree with the one the run judged.",
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
  "unexpected-failure": {
    severity: "failed",
    description:
      "A scenario's steps passed and the program failed underneath one of them in a way no @expects: tag of the scenario names: a response with a status from 500 to 599, an error the page threw that nothing caught, or an error the program reported in its execution events with handled: false. Its cell is broke, so the claims that held prove nothing about the criterion.",
    fix: "Fix what failed in the program. A scenario that causes the failure on purpose names it with a tag on its Scenario line, such as @expects:status=503, @expects:error=<class>, or @expects:page-error=<name>; the finding's fix: line spells the tag.",
  },
  "undeclared-write": {
    severity: "note",
    description:
      "A step that declares mutates: false has, in its trace, a write the program committed to a table that holds state: the execution events say the step changed what a later step may read, and its declaration says it did not. A write to a table the program's tables list marks as bookkeeping or infrastructure is not one, and neither is a write that rolled back or whose commit state no line decides.",
    fix: 'Declare mutates: true on the step when it is meant to write, or stop the write in the program when it is not; a table that holds bookkeeping or infrastructure is marked so in the program\'s tables list (docs/spec.md "Lists").',
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
