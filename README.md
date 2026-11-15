# nukadoko

[![npm version](https://img.shields.io/npm/v/nukadoko?logo=npm)](https://www.npmjs.com/package/nukadoko)

> Implementations are generated now. What checks them cannot be. Typed step
> contracts checked before anything runs, step records the tool measured,
> and a run summary that is the evidence, between natural-language
> acceptance criteria and what actually ran.

nukadoko runs Gherkin scenarios under typed step contracts and writes a
step record for every execution. The tool measures this record instead of
relying on an agent's report. The criteria remain in the language used by
the people who set them.
Everything between those sentences and the system under test is typed,
checked before execution, and reviewable in a diff. Every run ends in a
Markdown run summary, and the run is the evidence for its criteria: these
scenarios ran at this commit, under these conditions, and, with
`nuka run --base <ref>`, these criteria are new, changed, unchanged, or
removed since the base, each new or changed one failed a Then against the
base's code or did not, and each unchanged one still holds under the
steps it was approved with. A person reads the `.feature` and that summary.
Where their approval is recorded, a pull request review, a change ticket,
or an audit log, is the team's choice and stays outside nukadoko.

There are two engines. The npm package runs steps written in TypeScript,
and the `nukadoko` gem runs steps written in Ruby
([ruby/README.md](https://github.com/meganemura/nukadoko/blob/main/ruby/README.md)). Both read the same feature files and
must judge them the same way: the cases and scenarios in
[conformance/](https://github.com/meganemura/nukadoko/blob/main/conformance/README.md) run against each engine. This README
shows the TypeScript engine.

## Why this exists now

Code is increasingly written the way this sentence was: someone describes
what they want, and a model produces something plausible. That works, and
it changes what "verified" has to mean. When the implementation is
generated probabilistically, calling it correct requires something that was
fixed *before* it was generated and does not move. Otherwise the thing
being checked and the thing doing the checking are drawn from the same
distribution.

Acceptance criteria are already that fixed thing. The people who decide
what the software is for already write them in natural language. What has
been missing is a way to enforce those words. A written sentence must map
to an execution that either happened or did not. That mapping must be rigid
enough to prevent it from quietly agreeing with whatever was built.

That is what this is. Every step is a typed contract (schemas validated at
the boundary, dependencies declared and checked before anything runs),
every `Then` declares what it compares and where its expected value comes
from, and every execution leaves a record the tool wrote rather than the
agent. The
natural-language side stays soft, because that is where people think. The
mapping underneath it is deliberately rigid, because that is the only part
that can carry a guarantee.

Gherkin is not what this protects. It is what this is built on: a format
for stating acceptance criteria in natural language already exists,
together with its parser, its tooling, and a generation of people who can
read one without being taught. Reinventing that vocabulary to make the same
point would have been vanity. There is no nostalgia for Cucumber here: the
parts of it that could not carry a guarantee, namely untyped glue, a report
that only says `passed`, and keywords that mean nothing at run time, are
exactly the parts this replaces.

## Install

Node 22.18 or later on the 22 line, or 23.6 or later (`package.json`'s
`engines.node` is `"^22.18.0 || >=23.6.0"`): the releases that run a `.ts`
file without a flag. nukadoko loads the config and the step files with
Node's own type stripping, so it installs no TypeScript loader of its own.
nukadoko is a devDependency:

```sh
npm install -D nukadoko
```

It installs no browser. Playwright is an optional peer dependency, needed
only by a step that uses `page` or `request`. Such a project adds it, at
the version nukadoko is tested against, and the browser it launches:

```sh
npm install -D -E playwright@1.61.1
npx playwright install chromium
```

The peer range is `^1.61.1`, so a project already on a later Playwright
1.x keeps its own version.

Without it, `nuka check` names that step and this install command before
anything runs, and every other command works, `tsc` included: nukadoko's
types for `page` and `request` are `any` until Playwright is installed.

For a Ruby project, add `gem "nukadoko", group: :test` to the Gemfile
instead. It needs Ruby 3.4 or later, and [ruby/README.md](https://github.com/meganemura/nukadoko/blob/main/ruby/README.md)
lists what it runs today.

## Beside your unit tests

Unit tests (vitest, `node:test`) check functions from the inside. A
scenario checks the program from the outside, in sentences the person who
asked for the change can read on the pull request. The everyday loop is
four things: a `.feature` file, one `defineStep` per kind of line,
`nuka check`, and `nuka run`.

The walkthrough below adds one scenario to a project whose CLI,
`src/cli.ts`, prints `Hello, <name>!`. Every output block is copied from a
real run.
To add nukadoko to your own project one step at a time, from install to
CI, follow [docs/adopting.md](docs/adopting.md).

```sh
npx nuka init
```

```text
nukadoko.config.ts
features/steps
.gitignore
package.json
tsconfig.json
```

`init` adds `.nukadoko/` to `.gitignore`, a `test:scenarios` script to
`package.json` (the one command a person or CI runs), and the steps and the
config to the `include` of `tsconfig.json`, with the compiler option that
lets `tsc` accept an import that names a `.ts` file. It also adds `.env`,
`.env.*`, and `!.env.example` to `.gitignore`. The CommonJS case and the
`--allure` flag are in [Setup details](docs/guide.md#setup-details).

Scaffold the When step. `--command` writes a step that runs a program
in `scratch.dir()`, an empty directory that is removed after the scenario,
and returns its `exitCode`, `stdout`, and `stderr`. `runCommand` puts the
process it ran into the step record:

```sh
npx nuka scaffold run-greet --pattern "I run greet with {name:string}" --command src/cli.ts
```

```text
features/steps/run-greet.ts
```

`--command src/cli.ts` names the entry point, so the file needs no edit.
`resolve` reads it from the directory `nuka` runs in, and the scaffold
refuses a path that is not a file there. The step runs the entry point
with `node` itself, so in a project whose `.ts` files import each other
with `.js` specifiers the entry point is the built program (for example
`--command dist/cli.js`), and `"pretest:scenarios": "npm run build"` keeps
a fresh checkout green; the scaffold refuses a `.ts` entry point that
imports a `.js` file which is absent while its `.ts` sibling is present.
Without a value,
the line holds a TODO, and the step fails with the file and line until it
is filled in. The scaffold writes:

```ts
// features/steps/run-greet.ts
import { defineStep, runCommand, z } from "nukadoko";
import { resolve } from "node:path";

const cli = resolve("src/cli.ts");

export default defineStep({
  description: "Run the command under test in an empty scratch directory",
  pattern: "I run greet with {name:string}",
  // Give each field a .describe(): `nuka describe` shows it to whoever picks this step.
  args: z.object({
    name: z.string(),
  }),
  returns: z.object({
    exitCode: z.number().nullable(),
    stdout: z.string(),
    stderr: z.string(),
  }),
  // Set this to false when the program changes nothing outside a scratch directory.
  mutates: true,
  async run({ scratch }, { name }) {
    return await runCommand(process.execPath, [cli, name], { cwd: scratch.dir() });
  },
});
```

Scaffold the Then step from it. `--from run-greet.stdout` writes the
import, an `args` field typed from the When step's `returns`, and the
`from` entry that hands the Then step that value. `--description` writes
what the step checks; without it the description is a TODO that `nuka
check` reports as a note:

```sh
npx nuka scaffold output-says --pattern "the output says {text:string}" --then --from run-greet.stdout --description "The CLI printed exactly this line"
```

```text
features/steps/output-says.ts
```

A Then step has no body to write. It declares a claim, and nukadoko does
the comparing: the actual value is the `stdout` the When step returned,
the expected value is the `text` the feature line states, and the record
keeps both, with where each came from. greet ends its line with a newline
that the feature line does not show, so the claim reads `stdout` through
`view: "text"`, which trims the end, and the file needs no edit:

```ts
// features/steps/output-says.ts
import { defineStep, z } from "nukadoko";
import runGreet from "./run-greet.ts";

export default defineStep({
  description: "The CLI printed exactly this line",
  pattern: "the output says {text:string}",
  // Give each field a .describe(): `nuka describe` shows it to whoever picks this step.
  args: z.object({
    text: z.string(),
    stdout: runGreet.returns.shape.stdout,
  }),
  from: {
    stdout: [runGreet, "stdout"],
  },
  // The program ends its output with a newline that the feature line does not show.
  claims: [{ actual: "stdout", view: "text", compare: "equal", expected: "text" }],
});
```

The feature is the two sentences:

```gherkin
# features/greet.feature
Feature: greet

  Scenario: greets by name
    When I run greet with "Ada"
    Then the output says "Hello, Ada!"
```

Run it:

```sh
npm run test:scenarios
```

```text
> test:scenarios
> nuka run

scenario 1/1  features/greet.feature:4  greets by name
  step 1/2  passed  0.1s  I run greet with "Ada"
  step 2/2  passed  0.0s  the output says "Hello, Ada!"
steps     .nukadoko/runs/run-20261016-123947-b4q6/steps/  2
summary   .nukadoko/runs/run-20261016-123947-b4q6/summary.md
run       .nukadoko/runs/run-20261016-123947-b4q6/run.json
1 scenario: 1 passed, 0 failed  (2s)
```

Before it executes anything, `nuka run` reports what `nuka check` reports
for those scenarios and stops on an error, so a line no step matches never
reaches a run. `nuka check` alone is the same check, in seconds.

When a scenario fails, stderr names the step, its error, its step record,
and the command that reruns it. Here the feature expects `"Hi, Ada!"`,
and the broken claim names both values and where each came from: the
`stdout` of the step on line 5, and the `text` the sentence states:

```text
scenario 1/1  features/greet.feature:4  greets by name
  step 1/2  passed  0.1s  I run greet with "Ada"
  step 2/2  failed  0.0s  the output says "Hi, Ada!"
      claim broken: "Hello, Ada!" (from:run-greet@5.stdout as text) equal "Hi, Ada!" (sentence:text)
      record  .nukadoko/runs/run-20261024-123634-z9t2/steps/step-20261024-123634-s9j0
steps     .nukadoko/runs/run-20261024-123634-z9t2/steps/  2
summary   .nukadoko/runs/run-20261024-123634-z9t2/summary.md
run       .nukadoko/runs/run-20261024-123634-z9t2/run.json
1 scenario: 0 passed, 1 failed  (0s)
failed	scenario-failed	features/greet.feature:4	greets by name: claim broken: "Hello, Ada!" (from:run-greet@5.stdout as text) equal "Hi, Ada!" (sentence:text)
  do: nuka run features/greet.feature:4
```

The same facts go into the Markdown run summary. On GitHub Actions it
lands on the job's summary page by itself. Its first part:

```text
<!-- nukadoko:run -->
# nukadoko run failed: 1 criterion, 0 held, 1 failed

| verdict | criterion | head default |
| --- | --- | --- |
| failed | `features/greet.feature:4` greets by name | fail@6 |

- `features/greet.feature:4` greets by name: a claim broke at line 6 in default
  - step "the output says "Hi, Ada!"": `claim broken: "Hello, Ada!" (from:run-greet@5.stdout as text) equal "Hi, Ada!" (sentence:text)`; record `steps/step-20261024-123634-s9j0`

- commit: `e26cf85`
- environment: default
- browser: none launched
- selection: full
- nukadoko: 0.21.0
- run: run-20261024-123634-z9t2
- started 2026-10-24T12:36:34.018Z, finished 2026-10-24T12:36:34.449Z (0s)

## Claims

Each line is one claim of a Then: the actual value and where it came from, how it was compared, the expected value and where it came from, whether it held, and the recorded channel that holds the actual value (`measured: none` when no channel does, or when another channel holds the same number). An expected value an earlier step returned or `observe` read gets the same, as `expected measured`.

- `features/greet.feature:6` the output says "Hi, Ada!"
  - "Hello, Ada!" (from:run-greet@5.stdout as text) equal "Hi, Ada!" (sentence:text) broken; measured: observed.processes[0].stdout of step-20261024-123634-plgs
```

In CI it is one more line beside the unit tests
([docs/ci.md](docs/ci.md) has the whole workflow):

```yaml
- run: npm run test:scenarios
```

Commit `features/` (the feature and its steps), `nukadoko.config.ts`, and
the `package.json` change. Do not commit `.nukadoko/`: it holds the step
records and the run summaries, and `nuka init` already ignores it.

A program that is an HTTP server is described in `nukadoko.program.ts`,
and nukadoko starts it for each run: [An HTTP API](docs/guide.md#an-http-api)
walks the same loop against one.

## How a run is judged

A run reaches its verdict in three layers. Each layer is a record the tool
wrote, not a line an agent typed.

1. **Before anything runs.** `nuka run` first reports what `nuka check`
   reports for the scenarios it selected, and an error stops the run: a
   line no step matches, a line two patterns match, a `from` that reads a
   step the scenario has not run yet. [Wrong before it runs](#wrong-before-it-runs)
   shows what it catches.
2. **Each Then is claims.** A typed Then runs no code that asserts. It
   declares which value it reads, how it compares that value, and where the
   expected value comes from, and nukadoko does the comparing. A broken
   claim names both values and where each came from, as the failure above
   shows. See [Claims](docs/spec.md#claims).
3. **Each criterion is a row.** `run.json` and the run summary hold a
   verdict table: one row per criterion, one cell per environment. A row is
   `failed` when a required cell did not pass. A scenario tagged
   `@with:<switch>` also runs, as a control, in an environment that turns
   the switch off. When its Then fails there in two runs, the row is
   `proven`. When it passes, the row stays `held`: the Then does not see
   what the switch changes. `nuka run --base <ref>` adds the history of each
   criterion: it is `new`, `changed`, `unchanged`, or `removed` since the
   base. A new or changed one has to fail against the base's code to be
   `proven`, and is `unproven` otherwise. An unchanged one whose steps
   changed has to pass under the steps it was approved with, and is `moved`
   otherwise. See [Verdicts](docs/spec.md#verdicts).

The exit code follows the table: `1` when a row is `failed`, `unproven`, or
`moved`. `nuka verdict` says, without starting a run, whether the newest
run judged the working tree as it is now and left nothing red.

## Wrong before it runs

Gherkin states acceptance criteria as executable scenarios: `Given` /
`When` / `Then` lines in a `.feature` file, with the code behind each line
written separately. Those keywords are Cucumber's rather than this
project's, and [Cucumber's own Gherkin reference](https://cucumber.io/docs/gherkin/)
is where they are defined; nukadoko reads the format with Cucumber's own
parser.

```gherkin
Feature: Projects

  Scenario: A new project appears in the list
    Given a project "acme" exists
    Then the project list includes "acme"
```

You do not need to read the source to find the vocabulary behind those
lines. `nuka steps --json` lists it in a machine-readable form. An agent's
exploration loop starts with the same call. This repository's
`examples/todo` includes a small vocabulary. Its output contains this entry:

```json
{
  "name": "add-todo",
  "kind": "typed",
  "patterns": ["a todo titled {title:string} is added"],
  "description": "Create a todo via POST /todos and return the created record",
  "mutates": true,
  "needs": ["request"],
  "needs_browser": false
}
```

The entry appears under `steps`, beside `findings` in the envelope every
`--json` prints, `{ schema_version, nukadoko, command, verdict, findings,
steps }`. Each step file that the call could not import is a
`step-file-import-failed` finding (`playwright-missing` when the missing
package is Playwright), and `findings` is empty when all imports succeed.

Before anything runs, `nuka check` reads every feature file and step file,
then reports each problem. An undefined step is the simplest case. No step
definition matches the line's text, so `check` identifies the exact line
before a run can reach it. `nuka check` takes the targets `nuka run` takes,
several files or a directory (`nuka check features/checkout`), and checks
the files `nuka run` would select for them; with no target it checks the
whole project.

```
error	undefined-step	features/todo.feature:7	No step definition matches "the todo titled "Walk the dog" is completed"
  do: nuka scaffold --feature features/todo.feature
```

When a step that declares a pattern is bound by no line in the scanned
feature directories, the same message ends with `patterned steps no scanned
feature line binds:` and names that step, its pattern, and its file. A
renamed sentence or a renamed pattern leaves exactly that pair, so read
the list before you scaffold a second step.

When the feature comes first, `nuka scaffold --feature <file>` writes one
stub for each line `check` calls undefined, so each sentence is typed once:

```sh
npx nuka scaffold --feature features/greet.feature
```

```text
features/steps/i-run-greet-with.ts
features/steps/the-output-says.ts
features/steps/the-exit-code-is.ts
```

The pattern is the line as cucumber-expressions reads it: a quoted value
becomes `{value:string}`, an integer `{value:int}`, a decimal
`{value:float}`, and a Then line gets a claim step whose `observe` is a
TODO; a Then line that states no value gets no stub, only a note. A docstring below
the line becomes a `docstring: z.string()` key, and a table a `table` key
of rows. Rename `value` in the pattern and in `args` together. When a line reads more than one way
(a registered type and a built-in both fit), or its reading would also
match another line of the project, the stub keeps the line itself as its
pattern, with no capture, and a `note:` line on stderr says so.
The stubs declare no `returns` and no `from`. For a When that runs a
program and the Thens that read its result, scaffold one step at a time
with `--command` and `--then --from`, as
[Beside your unit tests](#beside-your-unit-tests) does. Each of those
names a file the stub already holds, so `--feature` ends its stderr with a
`next:` block: each stub's own single scaffold with `--replace`, which
writes the stub again as it is, for you to add those options to. A line
is printed only when it writes the same bytes. `--replace` overwrites a
file that is still, byte for byte, what scaffold writes under some set of
options (a `--feature` stub, or a `--command` or `--from` step with one
option wrong), and refuses a file anyone edited. Without it the refusal's `do:` line is that same
command with `--replace`.

A from-order violation is the case plain glue cannot even represent,
because without a typed contract there is nothing for the concept to
attach to. Step B declares `from` to read a value step A returned; here the
feature binds B before A has run anywhere in the scenario, and `check`
catches it before either step executes:

```
error	from-order-violation	features/chain.feature:11	Step "archive-project"'s from.projectId needs step "create-project" to have already run earlier in this scenario, but "create-project" is never bound anywhere in this scenario. This line would fail args validation with certainty
  fix: Put a line that runs step "create-project" earlier in the scenario.
```

These two cases are only examples. `nuka check --codes` answers "what can
this catch?" by listing every known finding code with a one-line
description. This README does not use a count that would become stale when
a code is added.

Running one step by itself requires no scenario and shows what remains
afterward. The result is a step record, not a pass/fail line.

```json
{
  "step_record_id": "step-20260804-224640-50lp",
  "step": "add-todo",
  "kind": "do",
  "args": { "title": "Buy milk" },
  "args_origin": { "title": "command_line" },
  "result": { "id": "5c07a3aa-d06a-4421-a708-9d69d8a238e3", "title": "Buy milk", "done": false },
  "status": "passed",
  "observed": {
    "processes": null, "http": 1, "files": null, "unmeasured": [],
    "program_log": { "trace_id": "9c41d07e5b2a4f60b1e83d7c2a90f415", "lines": 1, "file": "program-log.txt", "stamped": 1 }
  }
}
```

(`evidence`, `environment`, and the timestamps are trimmed above
for space; the real step record has them too.)

`args_origin` names where each argument came from: here the command line,
in a scenario a capture, the docstring, the table, or an earlier step's
result. `observed` holds what nukadoko measured while the step ran. Its
keys are `processes` (each `runCommand` process, with its stdin and the
environment variables it was given, a value shown only when it is a path
that exists, an integer, or a boolean), `http` (a count of the requests the step sent; each one is a
line in the step record's `http.jsonl`, with its request body and
response body), `files` (the files the step changed in a scratch
directory or wrote through `node:fs`, with their content), `program_log`
(when nukadoko starts the program, the lines of its log that carry the
step's trace id: each request to it carries a `traceparent` the program
can write into its lines; `null` for a program at a `url`), `events`
(when the program file names `{events}`, the program's own report of
what it did inside the step, one line per statement, job, or call, in
the format of [docs/execution-events.md](docs/execution-events.md)), and
`unmeasured`. That last one lists what nukadoko saw but cannot measure,
such as a process started without `runCommand`, so a record does not
look complete when nukadoko saw that it is not. A key is `null` when the step did nothing
of that kind.

An existing cucumber-js suite reaches this door too, by switching one
import (see
[Coming from cucumber-js or Playwright Test](#coming-from-cucumber-js-or-playwright-test)
below). But a compat step
has no typed contract, so `nuka check` has nothing here to hold a feature
line against, and `nuka do` refuses to run one by name at all.

`check` is the cheap static gate, and its notes are where rot shows up;
`run` leaves the step record trail and the run summary that is the run's
evidence.

## Running this in CI

`nuka check` and `nuka run` are both scriptable. Each exits with `0` when
everything holds and with a nonzero value when something is wrong. Either
command can therefore run as an ordinary pipeline step. The example below
is an excerpt. [docs/ci.md](docs/ci.md) contains complete workflows and
the four items that projects moving from `npx playwright test` usually add
manually.

```yaml
# excerpt from a CI workflow
- run: npm run test:scenarios      # nuka run: checks, then executes featuresDir, writes step records
```

One step is enough. `nuka run` reports what `nuka check` reports for the
scenarios it selected and exits `1` before executing anything when one is an
error, so a scenario that can only fail never costs a browser or minutes.
`--no-check` skips that check to run such a scenario anyway. When the run
is slow, put `nuka check` on its own as the fast PR gate (seconds, no
browser) and keep `nuka run` for merge or deploy. The gate can name the
same files or directories the run does (`nuka check features/checkout`),
and reports the errors that run would stop on; with no target,
`nuka check` also covers `additionalFeatureDirs`, which `nuka run` with no
target leaves out.

Running scenarios in parallel, repeating them, shuffling their order,
several environments in one run, comparing with a base commit, and why
nukadoko never retries a step until it passes are in
[CI runs in depth](docs/guide.md#ci-runs-in-depth).

## Agent-first is a design constraint, not a slogan

An agent must be able to complete the whole loop without assistance. It
discovers the vocabulary (`nuka steps --json`) and reads a contract
(`nuka describe`, with schemas as JSON Schema). It then executes one step
(`nuka do`, with a step record on stdout and a meaningful exit code), reads
the validated result, and selects the next call. When the vocabulary lacks
an operation, the agent scaffolds and implements a new step. A human then
reviews the PR.

That constraint produced most of the design. A step must run by itself, so
its dependencies must appear in its signature instead of on a World. This
also prevents `this.foo` from hiding data flow. The next call must be able
to read a result, so the tool validates the result instead of discarding it.
An agent's report cannot serve as the run record, so the tool writes the
step record. These properties serve agents and people alike. A suite that
an agent can drive is also a suite that a person can debug.

It also directs where this grows. End-to-end execution costs a browser and
minutes, so how much of a scenario can be judged wrong *without running it*
is how fast anyone iterates. For an agent, whose loop is made of cheap
commands, it is directly how fast it can correct its own work. Every
declaration here is partly paid for that way, and the standing question
after a failed run is whether `nuka check` could have caught it first.

Everything has a machine-readable form (`--json`). Rich human reporting is
delegated to Allure.

## Skills for coding agents

nukadoko ships two skills following the
[Agent Skills specification](https://agentskills.io/specification), so
Claude Code, Copilot, Cursor, Codex and Gemini CLI can all load them:

- **nukadoko.** Takes a ticket's acceptance criteria through to a
  feature and the run that is its evidence: read the vocabulary, scaffold
  what's missing, write the feature, run it green, and hand over the
  feature and its run summary for a person to review.
- **nukadoko-verification.** Puts scenarios under a project's verification skill
  (a control CLI that drives the running app, and a map of its
  features): which claims of the map a scenario proves, how the CLI and
  the steps share one library, how a bug report is reproduced red before
  it is fixed, and how evidence outlives cleanup.

```sh
gh skill install meganemura/nukadoko --all   # both, on any Agent Skills host
nuka skill path                              # the copy matching your installed version
```

Moving an existing suite across has no skill: it happens once, so point
the agent at [docs/migration.md](docs/migration.md), whose "Working rules"
section is written for whoever does the migration.

An agent with no skill loaded starts at `node_modules/nukadoko/llms.txt`:
the install facts, the loop, every command, and every finding code, in one
file. `nuka --help` ends by naming it, and so does `nuka init`.

No skill writes down what the CLI can answer (vocabulary, contracts,
refusal reasons all come from `nuka steps`, `nuka describe`, and stderr),
because a skill that copies those starts lying the moment a command
changes.

What they do carry is the discipline an agent won't invent on its own: stop
after three failed repair attempts and report where things stand instead of
guessing further; ask once before the first run of a step whose contract
says it mutates; never hand-edit a written record, and never delete one to
produce a cleaner one. An agent optimizing for a green run will otherwise
find the cheapest path to green, and the cheapest path is usually a weaker
assertion.

## Coming from cucumber-js or Playwright Test

An existing Cucumber + Playwright suite comes in by switching one import,
from `@cucumber/cucumber` to `nukadoko/compat`. The same patterns, hooks,
and World keep working, each step gains a step record, and each step can
move to `defineStep` on its own. The door is an entry point, not a
destination: a compat step has no contract, so `nuka check` has nothing to
hold its line against, and a green run confirms only that it ran. A
CommonJS suite cannot use the door until it changes its module format.
[docs/migration.md](docs/migration.md) is the step-by-step guide, and
[The compat door](docs/guide.md#the-compat-door) has the audit of eight
public suites.

A Playwright Test suite with no Gherkin keeps its own runner:
[docs/migration-playwright-test.md](docs/migration-playwright-test.md)
moves an operation into a plain function that both a spec and a typed step
call. To find out whether nukadoko fits before you move anything, paste the
[evaluation prompt](docs/guide.md#try-it-against-your-own-suite-first) into
an agent that works in your repository.

## What this does not do

- **Step records are not unforgeable.** An agent with shell access can write
  any file, step records included: the same honest limit secrets have. What
  nukadoko removes is the need to trust an agent's *account* of a run:
  execution and measurement stay with the tool, not with the agent
  describing them.
- **It does not check that a claim means what its sentence says.** A typed
  `Then` declares its claims, and what the tool promises is narrower than
  proof: the record never states something false (every label names where
  its value really came from, and every value shown is the value
  compared), and a way to make a claim hold that a reader of the record
  could not see is refused or broken. What a reader can see is left to
  the reader, and the record shows it: the run summary prints each claim
  under its sentence with its compare, its sources, and `measured: none`
  where no recorded channel holds the value, which is what a constant
  looks like, and it lists every scenario no claim judged. Whether
  `contains-text` is strong enough for a criterion that meant `equal`, or
  whether an `observe` reads the thing the sentence names, rests on PR
  review. Whether any other step truthfully does what its description
  claims rests on PR review too. The tool guarantees the shape of inputs
  and outputs and the fact of execution.
- **`mutates` is trusted, not re-derived from what the network shows.**
  The HTTP method is a proxy for write semantics, not the semantics
  itself: purely client-side state and a server that mutates on GET are
  invisible to it, and a semantically pure read implemented over POST
  (GraphQL, RPC-over-POST, many vendors' query endpoints) would look like a
  write it never made. No general HTTP-layer rule can tell those two cases
  apart, so nukadoko never infers a write from a method. See
  [Keyword semantics](docs/spec.md#keyword-semantics) for the fuller
  argument. The step record keeps each request it measured as a fact, so a
  wrong `mutates` declaration can be checked after the fact; the
  declaration and review carry the judgment.
- **It does not see every action a step takes.** It records what a step
  sends through `fetch`, `node:http`, `node:https`, Playwright, and the
  global `WebSocket`, each `runCommand` process, the files in scratch
  directories, and the `node:fs` writes of its own process. A process
  started without `runCommand` (named by its program and argument count
  only), a Worker, a connection the step opens or writes to that carries
  no recorded request, and what a WebSocket from a library over
  `node:http` (the `ws` package) carries after its handshake are
  named in `observed.unmeasured`, with no evidence of what they did. A
  native addon, a child process's own traffic, a write a child process
  makes outside a scratch directory and its working directory, a
  connection opened before the step that it only reads from, and a
  `fetch` an interceptor installed after nukadoko (such as msw) answers
  itself are not seen at all.
- **CommonJS suites cannot use `nukadoko/compat`** without a module-format
  change first (above).
- **No CI reporting or HTML rendering built in.** Allure's dashboard is the
  rendering
  ([Reports fill themselves](docs/guide.md#reports-fill-themselves)); what
  does and does not run in CI at all, including
  why retries specifically are not planned, is covered in
  [CI runs in depth](docs/guide.md#ci-runs-in-depth).

If a team concludes it does not need the natural-language layer at all
(that whoever decides what to build and whoever writes the checks are the
same people), then Playwright Test directly is a reasonable decision, and
this tool does not argue against it. The case here starts where those two
are different, and gets stronger the more of the implementation is written
by something that cannot be asked why it wrote that.

## Who reads what

A person who approves without writing code reads two things: the
`.feature`, to check it says what the ticket meant, and the run summary,
to check what ran, at which commit, and which criteria and step files
changed since the base they approved, as far as its comparison reaches.
Everything under
`.nukadoko/` and every `nuka` verb belongs to the agent or to CI. Every
`nuka run` writes that summary as Markdown: the commit, each environment,
the browser, one table per feature with each scenario's verdict in each
environment, its duration, and its failing step, a Claims section listing
every claim of every Then with its outcome and the channel it was measured in,
the scenarios no claim judged, each step with an action the tool could not
measure, and the command that reruns each failed scenario. On GitHub Actions it lands on the job's summary page
with no configuration, and `nuka report --format markdown --out <path>`
writes a copy a CI step can post as a PR comment ([docs/ci.md](docs/ci.md)). nukadoko records the
evidence, not the approval: the summary names the commit it describes, so
an approval recorded anywhere (a pull request review, a change ticket, an
audit log) can point at the run it approved, and nukadoko writes no
approval record of its own (see [Review](docs/spec.md#review)).

A person who wants to see each step for themselves can walk one scenario
with an agent beside them. `nuka run <file>:<line> --step` pauses after
each step with the world, the browser, and the fixtures still open; the
agent reads the step record and the views of the open pages to the
person, and the run goes on only when the person's answer comes back as
`nuka step next <n> --walk <w>` or `nuka step stop <n> --walk <w>`. A walked run says so in its
summary, since between steps the program was open to anything: it is a
way to understand a scenario, not the run that approves it (see
[A walk with a person](docs/spec.md#a-walk-with-a-person)).

## Status

**0.x.** The public API can change in any release until 1.0. That is the
whole 0.x range, not a stretch that ends at 0.1: reaching 0.1 will mean
more of the roadmap has landed, not that the surface has frozen.

Implemented and covered by tests: typed steps, step records, claims and
the verdict table, environments with conditions and controls, `--base`,
secrets, `nukadoko/compat`, Allure and cucumber-messages output through
`nuka report`, the Markdown run summary, a walk through one scenario with
`--step`, notes on what is rotting (`nuka check`), and two agent skills.
The Ruby engine reads the same feature files and passes every case and
scenario in [conformance/](https://github.com/meganemura/nukadoko/blob/main/conformance/README.md); what it does not run yet
is in [ruby/README.md](https://github.com/meganemura/nukadoko/blob/main/ruby/README.md). Not implemented: an AI-assisted
glue converter. See the [roadmap](docs/spec.md#roadmap).

Maintenance is one person working in the open. Every claim in this README
that carries a number was measured; where something was only reasoned
about, the text says so.

## Where to go next

- [docs/adopting.md](docs/adopting.md): add nukadoko to your own project one step at a time, from install to CI.
- [The guide](docs/guide.md): an HTTP API and `fetch`, setup details, upgrading, secrets, a step before and after its promotion, what nukadoko fixes, reports, self-healing, the compat door in full, CI runs in depth, and the notes `nuka check` adds.
- [docs/ci.md](docs/ci.md): complete CI workflows.
- [docs/migration.md](docs/migration.md) and [docs/migration-playwright-test.md](docs/migration-playwright-test.md): bring an existing suite in.
- [docs/upgrading.md](docs/upgrading.md) and the [changelog](CHANGELOG.md): what changed between versions, and what to do about it.
- [ruby/README.md](https://github.com/meganemura/nukadoko/blob/main/ruby/README.md): the Ruby engine.
- [conformance/](https://github.com/meganemura/nukadoko/blob/main/conformance/README.md): what both engines must judge the same way.

## Design

The full design (problem statement, typed steps, keyword semantics,
records, environments and secrets, review, roadmap, and honest
limits) lives in a single place: [docs/spec.md](docs/spec.md).

## License

[MIT](LICENSE)

---

[Japanese](README.ja.md)
