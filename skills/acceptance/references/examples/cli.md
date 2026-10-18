# Worked example: a command-line program

A finished project for a program run from the command line, built with
nukadoko 0.16.1 and rescaffolded with the releases after it (which added
`nuka scaffold --cwd` and then `--argv`) on Node 24.22.0. Every output block below is copied
from a real run of that project, which is `examples/acceptance/cli/` in
the nukadoko repository; CI runs it. The rules it follows are in
`../scenario-rules.md`.

## The ticket

`tally <file.csv> [--json]` sums amounts per category. The output is one
`category: total` line per category, sorted by name. `--json` prints the
same totals as one object. A file that cannot be read exits 2 with `tally:
cannot read <file>`. A line that is not `category,amount` exits 3 with
`tally: bad line: <line>`.

## The feature

`features/tally.feature`, written before the first `nuka run`. Every
expected value comes from the ticket.

```gherkin
Feature: tally sums amounts per category

  Acceptance criteria (from the request):
  - Given a CSV of category,amount lines, tally prints one "category: total" line per category, sorted by name
  - --json prints the same totals as one JSON object
  - A file that cannot be read is an error with exit code 2
  - A line that is not category,amount is an error with exit code 3

  Scenario: totals per category, sorted by name
    Given a file "input.csv" with these lines
      """
      rent,100
      food,3
      food,2.5
      """
    When I run tally with "input.csv"
    Then it exits with 0
    And the output is
      """
      food: 5.5
      rent: 100
      """

  Scenario: --json prints one object
    Given a file "input.csv" with these lines
      """
      rent,100
      food,3
      """
    When I run tally with "input.csv --json"
    Then it exits with 0
    And the output is
      """
      {"food":3,"rent":100}
      """

  Scenario: a file that cannot be read
    Given an empty directory
    When I run tally with "missing.csv"
    Then it exits with 2
    And the error says "tally: cannot read missing.csv"

  Scenario: a malformed line
    Given a file "input.csv" with these lines
      """
      rent,100
      oops
      """
    When I run tally with "input.csv"
    Then it exits with 3
    And the error says "tally: bad line: oops"
```

## The steps

- `a-csv-file-with` (Given): writes the docstring to `{name}` in a new
  `scratch.dir()` and returns `dir` and `bytes`.
- `an-empty-directory` (Given): returns a new `scratch.dir()` as `dir`.
- `run-tally` (When): `I run tally with {argv:string}`; reads `dir` from
  either Given through `from` and runs `src/cli.ts` there with
  `runCommand`. The scaffold wrote both `from` candidates, `cwd: dir`,
  and the split of `argv` on whitespace (`--argv argv`).
- `exits-with`, `output-is`, `error-says` (Then): each reads one key of
  `run-tally` through `from` and compares it with `node:assert/strict`.

Every step is `mutates: false`: the Givens write only inside the
scenario's scratch directory, and `tally` writes nothing.

`features/steps/run-tally.ts`. The scaffold wrote the imports, the `from`
entry, `cwd: dir`, the split of `argv`, and `returns`; the descriptions
and `mutates: false` are by hand (see "Decisions"):

```ts
import { defineStep, runCommand, z } from "nukadoko";
import { resolve } from "node:path";
import aCsvFileWith from "./a-csv-file-with.ts";
import anEmptyDirectory from "./an-empty-directory.ts";

const cli = resolve("src/cli.ts");

export default defineStep({
  description: "Run tally with these arguments in the directory an earlier step prepared",
  pattern: "I run tally with {argv:string}",
  args: z.object({
    argv: z.string().describe("Arguments after `tally`, separated by spaces"),
    dir: aCsvFileWith.returns.shape.dir,
  }),
  from: {
    dir: [[aCsvFileWith, "dir"], [anEmptyDirectory, "dir"]],
  },
  returns: z.object({
    exitCode: z.number().nullable().describe("The process exit code"),
    stdout: z.string().describe("Everything the process wrote to stdout"),
    stderr: z.string().describe("Everything the process wrote to stderr"),
  }),
  // Runs the program under test in a scratch directory a Given step made.
  mutates: false,
  async run({}, { argv, dir }) {
    return await runCommand(process.execPath, [cli, ...argv.split(/\s+/).filter((part) => part !== "")], { cwd: dir });
  },
});
```

`features/steps/output-is.ts`. The scaffold wrote the import, the `from`
entry, the key for the docstring, the assertion, and `mutates: false`;
the key's name `expected` and `trimEnd()` on both sides are by hand:

```ts
import { defineStep, z } from "nukadoko";
import assert from "node:assert/strict";
import runTally from "./run-tally.ts";

export default defineStep({
  description: "stdout is exactly the docstring, ignoring a trailing newline",
  pattern: "the output is",
  args: z.object({
    expected: z.string().describe("The expected stdout, verbatim"),
    stdout: runTally.returns.shape.stdout,
  }),
  from: {
    stdout: [runTally, "stdout"],
  },
  mutates: false,
  run({}, { expected, stdout }) {
    const actual = stdout.trimEnd();
    assert.equal(actual, expected.trimEnd(), `stdout: expected ${JSON.stringify(expected.trimEnd())}, got ${JSON.stringify(actual)}`);
  },
});
```

## The commands, in order

A producer has to declare its key in `returns` before a consumer is
scaffolded `--from` it. Scaffolding `run-tally` while `a-csv-file-with`
was still a stub:

```
$ npx nuka scaffold run-tally --pattern 'I run tally with {argv:string}' --command src/cli.ts --from a-csv-file-with.dir --argv argv
refused	step-inputs-invalid	-	Refusing to scaffold: a-csv-file-with declares no returns, so it has no key to chain; declare returns with "dir" in features/steps/a-csv-file-with.ts
  fix: Add returns: z.object({ dir: <its schema> }) to features/steps/a-csv-file-with.ts and return dir from its run().
  do: nuka scaffold run-tally --pattern 'I run tally with {argv:string}' --command src/cli.ts --from a-csv-file-with.dir --argv argv
```

Once both Givens returned `dir`, one command wrote the When step: each
`--from` for `dir` is one candidate producer, `--cwd dir` runs the
program in that directory instead of a new, empty one, and `--argv argv`
splits the capture on whitespace, so `"input.csv --json"` reaches the
program as two arguments:

```
$ npx nuka scaffold run-tally --pattern 'I run tally with {argv:string}' --command src/cli.ts --from a-csv-file-with.dir --from an-empty-directory.dir --cwd dir --argv argv
features/steps/run-tally.ts
```

Every `the output is` line in the feature carries a docstring, so the
Then step got a `docstring` key beside the chained `stdout`, and its body
compares the two:

```
$ npx nuka scaffold output-is --pattern 'the output is' --then --from run-tally.stdout
features/steps/output-is.ts
```

A red run, with `rent: 101` in the docstring for the first scenario. The
first line of the message carries both values:

```
  step 4/4  failed  0.0s  the output is
      stdout: expected "food: 5.5\nrent: 101", got "food: 5.5\nrent: 100"
      record  .nukadoko/runs/run-20261018-135515-h7mq/steps/step-20261018-135515-rux7
```

The run that passed:

```
$ npx nuka check
ok: no issues found
$ npx nuka run
...
4 scenarios: 4 passed, 0 failed  (2s)
$ npx nuka run --probe
...
4 scenarios: 4 passed, 0 failed  (2s)
$ npx nuka tend
scanned: features
bed: typed 6, compat 0, read-only 6
declared: describe 16/16
ok: nothing to tend
```

Two probes, outside the feature, for the rules `nuka check` enforces. A
scenario with no Then (S2):

```
warning	scenario-without-then	probe/no-then.feature:3	Scenario "a run with no claim" has no Then step, so it passes whenever its steps run without an error, and no step checks an outcome.
  fix: Add a Then line that checks the outcome the scenario is for.
```

The action under test written as a Given, with no Given before it (S10):

```
error	from-order-violation	probe/given-run.feature:4	Step "run-tally"'s from.dir needs exactly one of its candidate producers ("a-csv-file-with", "an-empty-directory") to have already run earlier in this scenario, but none has: "a-csv-file-with" is never bound anywhere in this scenario; "an-empty-directory" is never bound anywhere in this scenario. This line would fail args validation with certainty
  fix: Put a line that runs exactly one of steps "a-csv-file-with", "an-empty-directory" earlier in the scenario.
```

## Decisions

| Date | Decision | Chosen | Why | Became |
| --- | --- | --- | --- | --- |
| 2026-10-16 | How the input file reaches the program's working directory | the Given returns `dir`, the When reads it through `from` and runs there (`--cwd dir`) | each `scratch.dir()` call is a new directory, so the program has to run in the one the Given wrote to | Shapes: a program's input file |
| 2026-10-16 | One capture per argument, or one for all | `{argv:string}`, split on whitespace (`--argv argv` since 2026-10-18) | one When step serves every flag and the missing-file path | Shapes: arguments |
| 2026-10-16 | `mutates` on the `--command` step | `false`, with a comment | the scaffold writes the default `true`; `tally` writes nothing and runs in a scratch directory | SKILL.md "Before the first command" |
| 2026-10-16 | Which assertion, with no Playwright installed | `node:assert/strict`, with both values in the message | `playwright/test` does not resolve in this project | S11 |
| 2026-10-16 | Does `--json` also claim the exit code | yes, `Then it exits with 0` | a program that crashed after printing would pass without it | S1 |
| 2026-10-16 | Does the output compare the trailing newline | no, both sides are trimmed at the end, and the description says so | the program ends its output with a newline that the docstring does not show | none |
| 2026-10-17 | Order of scaffolding | Givens first, then the When, then the Thens | `--from` refuses a producer that does not return the key yet | SKILL.md "The loop" |
