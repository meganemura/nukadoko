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
`nuka run --since <ref>`, these criteria and step files changed since the
base a person approved, as far as its comparison reaches. A person reads the `.feature` and that summary.
Where their approval is recorded, a pull request review, a change ticket,
or an audit log, is the team's choice and stays outside nukadoko.

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
`--allure` flag are in [Setup details](#setup-details).

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
tend` reports:

```sh
npx nuka scaffold output-says --pattern "the output says {text:string}" --then --from run-greet.stdout --description "The CLI printed exactly this line"
```

```text
features/steps/output-says.ts
```

The body it writes is already an assertion: `actual` is the `stdout` the
When step returned, and `node:assert/strict` compares it with the `text`
the feature line supplies, with a message that names both values. greet
ends its line with a newline that the feature line does not show, so the
body drops that one newline before it compares, and the file needs no
edit:

```ts
// features/steps/output-says.ts
import { defineStep, z } from "nukadoko";
import assert from "node:assert/strict";
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
  mutates: false,
  run({}, { text, stdout }) {
    // The program ends its output with a newline that the feature line does not show.
    const actual = stdout.replace(/\r?\n$/, "");
    assert.equal(actual, text, `text: expected ${JSON.stringify(text)}, got ${JSON.stringify(actual)}`);
  },
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
and the command that reruns it. Here the feature expects `"Hi, Ada!"`:

```text
scenario 1/1  features/greet.feature:4  greets by name
  step 1/2  passed  0.1s  I run greet with "Ada"
  step 2/2  failed  0.0s  the output says "Hi, Ada!"
      text: expected "Hi, Ada!", got "Hello, Ada!"
      record  .nukadoko/runs/run-20261016-123950-zrhr/steps/step-20261016-123950-kjs1
steps     .nukadoko/runs/run-20261016-123950-zrhr/steps/  2
summary   .nukadoko/runs/run-20261016-123950-zrhr/summary.md
run       .nukadoko/runs/run-20261016-123950-zrhr/run.json
1 scenario: 0 passed, 1 failed  (1s)
failed	scenario-failed	features/greet.feature:4	greets by name: text: expected "Hi, Ada!", got "Hello, Ada!"
  do: nuka run features/greet.feature:4
```

The same facts go into the Markdown run summary. On GitHub Actions it
lands on the job's summary page by itself. Its first part:

```text
<!-- nukadoko:run -->
# nukadoko run failed: 1 scenario, 0 passed, 1 failed

- commit: `507dc66`
- environment: default
- browser: none launched
- nukadoko: 0.15.0
- run: run-20261016-123950-zrhr
- started 2026-10-16T12:39:48.835Z, finished 2026-10-16T12:39:50.265Z (1s)

## features/greet.feature

| scenario | line | default | duration | failure |
| --- | --- | --- | --- | --- |
| greets by name | 4 | failed | 0.1s | step "the output says "Hi, Ada!"": `text: expected "Hi, Ada!", got "Hello, Ada!"`<br>record `steps/step-20261016-123950-kjs1` |
```

In CI it is one more line beside the unit tests
([docs/ci.md](docs/ci.md) has the whole workflow):

```yaml
- run: npm run test:scenarios
```

Commit `features/` (the feature and its steps), `nukadoko.config.ts`, and
the `package.json` change. Do not commit `.nukadoko/`: it holds the step
records and the run summaries, and `nuka init` already ignores it.

## An HTTP API

`nuka init` sets up an API project the same way. Name the command that
starts the server and the URL it listens at, and init writes the fixture
that starts it. The When step sends its request through Playwright's
`request`, so install `playwright` too (init names the line when it is
missing):

```sh
npx nuka init --server "node src/server.ts" --server-url http://127.0.0.1:3000
npm install -D -E playwright@1.61.1
```

The config gets `baseURL` and two fixtures. `server` calls `runServer`,
which starts the command (split on whitespace, no shell) and waits until
the URL's port accepts a connection; the program has to listen there
itself, since nukadoko tells it no port. `request` destructures
Playwright's own `request` and `server` and hands the builtin back, so
every step that sends a request starts the server first, once per
scenario:

```ts
// nukadoko.config.ts (the server fixture)
server: async ({ baseURL }, use) => {
  const server = await runServer("node", ["src/server.ts"], { url: baseURL });
  await use(server);
  await server.stop();
},
```

Here `src/server.ts` listens at `127.0.0.1:3000` and answers
`/greet/<name>` with the text `Hello, <name>!`. With this feature:

```gherkin
# features/greet.feature
Feature: greet API

  Scenario: greets by name
    When I request the greeting for "Ada"
    Then the greeting is "Hello, Ada!"
```

scaffold the When step and its Then, and the scenario runs with no edit:

```sh
npx nuka scaffold get-greeting --pattern "I request the greeting for {name:string}" --request "GET /greet/{name}"
npx nuka scaffold greeting-is --pattern "the greeting is {text:string}" --then --from get-greeting.body
```

`get-greeting` is one ``request.fetch(`/greet/${name}`, { method: "GET" })``
call that returns `status` and `body` (the response text). Each request
lands in the step record's `http.jsonl` and in `observed.http_reads` and
`observed.http_writes`.

`--request "<METHOD> <path>"` resolves the path against `baseURL`. Each
`{key}` in the path is that args key's value, put in as it is, and
`--body <key>` sends an args key (the line's `docstring`, say) as the
request's data. A value the request does not read throws by name until
it is placed. The step writes `mutates: true`: the method is a proxy for
write semantics, so the author sets `false`.

A server that picks its own free port, or starts in-process, is
[a server you start yourself](#a-server-you-start-yourself).

## A server you start yourself

A server you start from your own code takes a fixture you write, and its
steps call it with `fetch`. Here
`src/server.ts` exports `startServer()`, which listens on a free port and
resolves to `{ url, close() }`:

```ts
// nukadoko.config.ts
import { defineConfig, defineFixtures } from "nukadoko";
import { startServer } from "./src/server.ts";

export default defineConfig({
  fixtures: defineFixtures({
    server: [
      async ({}, use) => {
        const server = await startServer();
        await use(server);
        await server.close();
      },
      { scope: "process" },
    ],
  }),
});

declare module "nukadoko" {
  interface StepFixtures {
    server: Awaited<ReturnType<typeof startServer>>;
  }
}
```

`{ scope: "process" }` starts one server for the whole `nuka run`, not one
per scenario. The server starts the first time a step destructures
`server`, and the line after `use()` is its teardown. The `declare module`
block gives `server` its type for `tsc`. `nuka check` reads fixture names
from the source text, so it does not need the block.

```ts
// features/steps/get-greeting.ts
import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "GET /greet/<name> from the server under test",
  pattern: "I request the greeting for {name:string}",
  args: z.object({ name: z.string() }),
  returns: z.object({ status: z.number(), message: z.string() }),
  async run({ server }, { name }) {
    const response = await fetch(`${server.url}/greet/${encodeURIComponent(name)}`);
    const body = (await response.json()) as { message: string };
    return { status: response.status, message: body.message };
  },
});
```

`fetch` needs nothing installed. `ctx.request()`, Playwright's
`APIRequestContext`, is the other way to call the server: it needs
`playwright` installed, and it is what counts the step's calls in the step
record's `observed.http_reads` and `observed.http_writes`. A step that only
calls `fetch` records both as `null`: nukadoko did not see its requests, and
`null` says so where `0` would claim a measurement.

The Then step comes from `nuka scaffold message-is --pattern "the message
is {text:string}" --then --from get-greeting.message`, the same way
`output-says` came from `run-greet`. The message carries no newline, so
its assertion runs as scaffolded, with no edit. The feature:

```gherkin
# features/greet.feature
Feature: greet API

  Scenario: greets by name
    When I request the greeting for "Ada"
    Then the message is "Hello, Ada!"
```

## More

Everything past the loop above, one line each:

- [Wrong before it runs](#wrong-before-it-runs): what `nuka check` catches before anything executes, and running one step alone with `nuka do`.
- [The compat door](#the-compat-door): bring an existing cucumber-js suite in by switching one import.
- [Reports fill themselves](#reports-fill-themselves): `nuka report`, which renders a finished run as Allure results, a cucumber-messages stream, or the Markdown summary.
- [Running this in CI](#running-this-in-ci): one step for the whole gate, a separate `nuka check` when the run is slow, `--concurrency`, and `--repeat`.
- Environments and secrets ([Secrets need no manifest](#secrets-need-no-manifest), and "Environments and secrets" in [docs/spec.md](docs/spec.md#environments-and-secrets)): named environments, redaction.
- [Skills for coding agents](#skills-for-coding-agents): the two skills an agent loads to run this loop.
- [The bed has to be tended](#the-bed-has-to-be-tended): `nuka tend`, for what is rotting rather than broken.
- [Setup details](#setup-details), [Upgrading](#upgrading), [Status](#status), and [Why this exists now](#why-this-exists-now).

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
`{value:float}`, and a Then line gets `mutates: false`. A docstring below
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
  "result": { "id": "5c07a3aa-d06a-4421-a708-9d69d8a238e3", "title": "Buy milk", "done": false },
  "status": "passed",
  "observed": { "http_reads": 0, "http_writes": 1, "processes": null }
}
```

(`evidence`, `environment`, and the timestamps are trimmed above
for space; the real step record has them too.)

An existing cucumber-js suite reaches this door too, by switching one
import (see [The compat door](#the-compat-door) below). But a compat step
has no typed contract, so `nuka check` has nothing here to hold a feature
line against, and `nuka do` refuses to run one by name at all.

`check` is the cheap static gate; `run` leaves the step record trail and
the run summary that is the run's evidence; `tend` is the periodic one, and the
only one you are meant to *not* run before every change.

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
the boundary, dependencies declared and checked before anything runs), and
every execution leaves a record the tool wrote rather than the agent. The
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

## Status

**0.x.** The public API can change in any release until 1.0. That is the
whole 0.x range, not a stretch that ends at 0.1: reaching 0.1 will mean
more of the roadmap has landed, not that the surface has frozen.

Implemented and covered by tests: typed steps, step records,
environments, secrets, `nukadoko/compat`, Allure and cucumber-messages
output through `nuka report`, the Markdown run summary, tending (`nuka tend`), and two
agent skills. Not implemented: an AI-assisted glue converter. See the [roadmap](docs/spec.md#roadmap).

Maintenance is one person working in the open. Every claim below that
carries a number was measured; where something was only reasoned about,
this README says so.

## Setup details

`nuka init` sets up a CLI or API project ([An HTTP API](#an-http-api)
shows the API shape). It adds `.nukadoko/` to
`.gitignore` unless a line there already ignores that directory
(`.nukadoko`, `/.nukadoko/`, and `.nukadoko/**` count), and
`"test:scenarios": "nuka run"` to the `package.json` scripts, unless a
script by that name already exists; when that script runs something else,
`init` says so on stderr. `npm run
test:scenarios` is then the one command a person or CI runs: `nuka run`
with no target runs `featuresDir`, and it reports what `nuka check` reports
for those scenarios and stops before executing anything when one is an
error.
When `tsconfig.json` has an `include` that leaves out `features/` or the
config file, `init` appends the missing entries to it and keeps the rest of
the file as it was, comments and trailing commas included. A
`tsconfig.json` with no `include` of its own
already checks every file. When its `compilerOptions` names neither
`allowImportingTsExtensions` nor `rewriteRelativeImportExtensions`, `init`
adds `"rewriteRelativeImportExtensions": true` (TypeScript 5.7 or later),
so `tsc` accepts the `./run-greet.ts` import that `nuka scaffold --from`
writes. That option is valid whether the project emits or not, and it
changes only the output of an import that names a `.ts` file. A file
that `tsconfig.json` extends can name the option instead, and then `init`
leaves it alone. When the options come only through `extends` and no
file there names it, or `init` cannot read one, `init` says so on
stderr. In a project whose `tsconfig.json` sets neither option to true,
`nuka scaffold --from` writes `./run-greet.js` instead, the name `tsc`
accepts under any options and `nuka` loads as `run-greet.ts`, and says so
in one `note:` line on stderr. `init` takes one flag: `--allure` writes
`allurerc.mjs` and creates the directory `nuka report` writes Allure
results to (see
[Reports fill themselves](#reports-fill-themselves)). `init` always adds
`.env`, `.env.*`, and `!.env.example` to `.gitignore`; delete those lines
if the project commits a `.env` on purpose.
Run `nuka` from the directory that holds the config, the package in a
workspace: a command run where there is none says so on stderr, names a
config in a parent directory if one exists, and `nuka scaffold` then
refuses to write.

Node runs the step files by erasing their types, so two kinds of
TypeScript do not load. Syntax with run-time behavior (an `enum`, a
`namespace`, a constructor parameter property) is refused, and `nuka check`
reports `step-file-import-failed` at its line with the rewrite to make. A
name imported without `type` that is only a type stays an import and fails
with Node's "does not provide an export named" error. For a type that
nukadoko itself exports, such as `IWorldOptions`, the finding says to
write `import type`. Setting
`"erasableSyntaxOnly": true` and `"verbatimModuleSyntax": true` in
`compilerOptions` makes `tsc` report both before `nuka` runs. An import
that names a `.js` file next to a `.ts` file (`./run-greet.js` for
`run-greet.ts`) still loads under `nuka`, which maps the one to the
other; plain `node` does not, which is why the scaffold writes the `.ts`
name.

nukadoko ships its TypeScript source alongside `dist/`, so stack traces
point to the actual code. An agent reading
`node_modules` can see why something works, not only its type.

If an existing `package.json` has no `"type": "module"`, the project uses
CommonJS, as a plain `npm init -y` does. `nuka init` still works. It writes
`nukadoko.config.mts` instead of `nukadoko.config.ts` and prints a one-line
reminder that step files also need `.mts`. nukadoko supports only ESM. In
such a project, Node first reads a plain `.ts` file as CommonJS, then
reparses it as an ES module with a warning on every load. With
`"type": "commonjs"`, it does not reparse, and the file fails to import.

<details>
<summary>No `package.json` yet (Rails, Django, and other non-Node repos)?</summary>

Create one first. Skip `npm init -y`. It copies the first line of the
existing `README.md` into `description` and the directory name into `name`.
Writing the minimum by hand is more reliable:

```json
{ "private": true, "type": "module" }
```

`"type": "module"` keeps every generated file as `.ts`, which is the simpler
of the two paths above. Leaving it out is still supported (see the CommonJS
paragraph above). However, a hand-written `nukadoko.config.ts` in such a
project loads with a warning, and fails to import under
`"type": "commonjs"`. That error names the file and the cause, and says to
rename it to `nukadoko.config.mts`. `nuka init` writes
`nukadoko.config.mts` instead. You do not need to add `.nukadoko/` to
`.gitignore` yourself because `nuka init` does that. It also adds `.env`
and `.env.*`, and leaves `.env.example` tracked. Traces and
screenshots inside the state directory are not redacted, so it contains
sensitive data.

</details>

## Upgrading

Use `npm install -D nukadoko@latest`. npm writes a caret range during
installation. While the major version is 0, a caret also pins the minor
(`^0.14.1` allows `0.14.x` only; for `0.0.x` it pins the patch), so
`npm update` alone never moves beyond the initially installed minor.
While this is 0.x, any release can change the public API. Read the
[changelog](CHANGELOG.md) instead of relying on the range for safety.
For what to actually fix after a breaking change, see
[docs/upgrading.md](docs/upgrading.md).

## Secrets need no manifest

Point `envFiles` at the existing env files, and git classifies them. An
untracked file is a secret source, so every value it defines is redacted
from logs and step records. A tracked file whose working tree matches HEAD
is plain configuration and stays unchanged. Uncommitted edits in a tracked
file are redacted the same way. No manifest or manual copy into a second
file is required.

## Before / after

Promoting a step from regex glue to a typed one. The feature line's text
doesn't change: only the step definition behind it does.

Before (cucumber-js, position capture, untyped, stashed on the World: the
per-scenario `this` object cucumber-js gives every step):

```ts
// features/steps/project.ts (cucumber-js)
import { Given } from "@cucumber/cucumber";

Given("a project {string} exists", async function (name: string) {
  const res = await this.request.post("/projects", { data: { name } });
  const body = await res.json();
  this.project = body; // stashed on World — no schema, no type
});
```

After (`defineStep`, named capture, zod, step-record-backed):

```ts
// features/steps/create-project.ts
import { defineStep, z } from "nukadoko";

export default defineStep({
  pattern: "a project {name:string} exists",
  description: "Create a project and return its id",
  args: z.object({ name: z.string() }),
  returns: z.object({ id: z.string(), name: z.string() }),
  mutates: true,
  async run({ request }, args) {
    const res = await request.post("/projects", { data: args });
    return res.json();
  },
});
```

- Named capture (`{name:string}`) binds the value to `args.name` by name.
  With position capture, reordering two same-typed values in the pattern
  silently swaps which one lands where; `nuka check` also flags a bare
  `{string}` as an error before that can happen.
- `args` and `returns` are zod schemas validated at the run boundary.
  `result` in the step record is something the tool validated, not just
  whatever the step handed back. `z` above comes from nukadoko itself, so
  there is no zod to install separately; if your own project already uses
  zod and passes one of its own schemas in, that schema needs to be zod 4.
- `request` above (and `page` for browser steps) is destructured straight
  out of `run`'s first argument, the fixture bag; only the names a step
  actually destructures ever get built, so a step that never names `page`
  never launches a browser (and a project with no such step does not
  install Playwright at all; see [Install](#install)). Both hand back
  Playwright's own
  `APIRequestContext` and `Page` objects, not a nukadoko wrapper, so
  existing Playwright knowledge and helpers carry over directly.
- `request.post("/projects", ...)` above resolves that relative path
  against `nukadoko.config.ts`'s own `baseURL` (spelled with a capital
  `URL`, matching Playwright's own key). Leave it unset and only an
  absolute URL works.
- `nuka do create-project --args '{"name":"acme"}'` runs this step by
  itself and prints its step record. This record is the unit of an agent's
  exploration loop, and the command requires no prior setup.

## What it fixes

Each row is a place where the mapping between a sentence and an execution
used to go soft. They are stated against cucumber-js because that is where
they are most familiar, not because it is the only layer that has them.

| The failure | What nukadoko does about it |
|---|---|
| Duplicate steps: which one matched? | `nuka check` reports **duplicate patterns** (the same text registered twice) and **ambiguous steps** (one line in a feature that two different patterns could both match), before anything runs |
| `this.foo`: an untyped bag | A step returns a value against a `returns` schema; a later step declares `from` to read one key of it by name: a dependency that shows up as an import in the diff, a read that lands on the receiving step's step record, and a binding order `nuka check` verifies before anything runs (see [Chaining steps](docs/spec.md#chaining-steps)) |
| A report that only says `passed` | Every execution writes a step record: validated result, the network reads and writes the tool itself observed, evidence, environment, target version |
| Undefined steps found at run time | `nuka check <feature>` fails on them statically, and names the text that matched nothing |
| A `Then` that quietly mutates state | `mutates` is a declaration nukadoko trusts, not a number it re-derives: a step declaring `mutates: true` is refused before it runs in a read-only environment and flagged by `nuka check` when bound to `Then`; what actually ran is still recorded on the step record for review |

The last row requires precision because the tool once failed on the count
instead of the promise. That behavior made a claim the measurement could
not support. Write detection uses the HTTP method as a proxy. This proxy
fails for GraphQL, RPC-over-POST, and vendor query APIs that perform a pure
read over POST. A truthful `mutates: false` step that calls one of these
APIs still looks like a write. No general HTTP-layer rule can distinguish
that call from a real write. Nukadoko therefore trusts the declaration. It
still counts every call other than GET and HEAD made through its request context and page,
but the step record presents the count as a fact, not a verdict.

## Reports fill themselves

A classic Cucumber run shows only the evidence that a team wires up. Each
project must write and maintain hook boilerplate for traces and screenshots.
[Allure](https://allurereport.org/) is a test-report dashboard; nukadoko
writes results in its format and never renders HTML itself.
`nuka report --format allure` fills the report from every step record of a
finished run without additional wiring. It adds
the validated result, trace, HTTP log, observed reads and writes,
environment, and version. One item cannot be added on the report side in
classic Cucumber because Cucumber discards step return values: the
validated result for each step.

Under each step sits a timeline of what happened inside it, built from
absolute timestamps: the stages it reached, every wait with its real
duration and how many attempts it took, and every Playwright call it made
including the assertions. One attempt and forty attempts ask for opposite
fixes, and nothing else in a report tells them apart. Counts of what the
page itself said (console errors, uncaught errors, failed requests) sit
beside the step, so a step that passed while the page threw three
uncaught errors says so without anyone opening an attachment. The trace
attached is that step's own, not the whole scenario's, so the failing
step opens directly instead of being scrubbed for. That same `trace.zip`
also sits under the step record on its own, and opens outside Allure with
`npx playwright show-trace <evidence.dir>/trace.zip`. The step record is
attached whole as well, which is what keeps this list from going stale:
anything a step record gains later arrives in the report without a second
mapping to remember.

`nuka report --format messages` writes a cucumber-messages (NDJSON) stream
of the same run, so a migrating team's existing formatters and JUnit-based
CI keep working: confirmed by running our own stream through
`@cucumber/junit-xml-formatter`, not just asserted. That formatter names
a test case from the scenario, so a plain Scenario run in two
environments is two test cases of one name there. See
[Allure results](docs/spec.md#allure-results) and
[Messages stream](docs/spec.md#messages-stream).

`nuka run` writes neither. `nuka report` renders them after the run, from
the run directory alone, so a run directory copied off a CI machine renders
too, and one run can be rendered again in another format:

```sh
npx nuka run
npx nuka report --format allure                        # .nukadoko/export/allure-results
npx nuka report --format messages --out messages.ndjson
npx nuka report .nukadoko/runs/<run_id> --format allure --out reports/allure
```

With no run directory it renders the newest run. `--out` moves where the
output lands; without it, Allure results go to
`.nukadoko/export/allure-results` and the other two formats go to stdout.

Since nukadoko writes results and never HTML, rendering them is Allure 3's
CLI (`npm i -g allure`, or `npx allure` as below):

```sh
R=.nukadoko/export/allure-results
npx allure watch $R --output .nukadoko/allure-report     # live, re-renders as a run writes
npx allure generate $R --output .nukadoko/allure-report
npx allure open .nukadoko/allure-report                  # serve one already generated
```

A generated report's `index.html` cannot open directly through `file://`.
The report's SPA fetches `widgets/*.json` during loading, which `file://`
cannot serve. The header and footer still render, so the broken report can
look valid at a glance. This problem occurs after someone downloads a CI
report artifact and opens `index.html` locally. Serve the report with
`npx allure open` or `npx allure watch` instead.

`nuka init --allure` writes `allurerc.mjs` at the project root (skipped, with a
message, if a project already has one under any name Allure auto-detects);
without it, every nukadoko failure lands in Allure 3's one built-in
"Product errors" category instead of one of the seven `error.kind` ones. A
project not using `init` can copy
[examples/allure/allurerc.mjs](https://github.com/meganemura/nukadoko/blob/main/examples/allure/allurerc.mjs)
by hand.

Pass `--output` to each command. Allure defaults it to `allure-report/`
in the current directory, and `watch` writes there too, so the default
leaves a generated report sitting in your repository root, untracked and
un-ignored, from nothing more than looking at a report. Sending it under
`.nukadoko/` puts it where `nuka init` already added a gitignore entry.

Use `watch` while iterating. Leave it running in one terminal, and run
`nuka run` then `nuka report --format allure` in another; the report
updates when the render lands. `watch` serves on a random port (`--port`
selects one) and opens a browser only with `--open`. `nuka init --allure`
creates `.nukadoko/export/allure-results/` so `watch` can start before the
first render.

Rendering the same run again replaces what its last render wrote, so the
directory holds one copy of each scenario. A run's files leave with the
run once it is older than the newest `retention.runs` runs (default 20),
so a report shows at most that many runs; `nuka clean` empties the
directory at once, together with the records.

## Self-healing, with the deviation on the record

A scripted scenario breaks because the app changed, not because the test was
wrong. The repair loop nukadoko is built for:

1. An agent re-runs the goal adaptively through `nuka do`, one step at a
   time, reading each step record to decide the next call. It is not replaying
   the broken scenario; it is finding out what works now.
2. Those step records record the sequence that actually worked, which, by
   definition, deviates from the scripted one. They are the narrative of the
   repair, not its proof, and the agent cites them in the PR as exactly
   that.
3. The PR updates the typed steps or the feature file, and its proof is the
   repaired scenario running green: its entry in `run.json` and its step records,
   reviewed like any other change.

Step 2 is the critical part. **Self-healing without an audit trail lets a
suite silently stop testing anything.** A scenario rewritten to match the
app's current behavior still passes, but nobody can see that its former
check disappeared. Here, the reviewer can read a record of the deviation.
Attestation always passes through the scenario instead of an ad-hoc
sequence.

nukadoko's contribution is that every stage leaves a record. The authoring is
an agent workflow (the bundled skills, below), not engine magic. See
[Self-healing, audited](docs/spec.md#self-healing-audited).

This loop does **not** catch another way a suite can become hollow. A
scenario can remain intact while its `Then` becomes weaker. A step record
shows what the execution did, but it cannot show whether an assertion still
has meaning. Review must catch that problem, as
[What this does not do](#what-this-does-not-do) explains.

## Skills for coding agents

nukadoko ships two skills following the
[Agent Skills specification](https://agentskills.io/specification), so
Claude Code, Copilot, Cursor, Codex and Gemini CLI can all load them:

- **acceptance.** Takes a ticket's acceptance criteria through to a
  feature and the run that is its evidence: read the vocabulary, scaffold
  what's missing, write the feature, run it green, and hand over the
  feature and its run summary for a person to review.
- **migration.** Moves a cucumber-js suite across in two stages, and
  explains which differences are the point rather than listing recipes.

```sh
gh skill install meganemura/nukadoko --all   # both, on any Agent Skills host
nuka skill path                              # the copy matching your installed version
```

An agent with no skill loaded starts at `node_modules/nukadoko/llms.txt`:
the install facts, the loop, every command, and every finding code, in one
file. `nuka --help` ends by naming it, and so does `nuka init`.

Neither skill writes down what the CLI can answer (vocabulary, contracts,
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

## The compat door

None of the above assumes an existing suite. This section is for the case
where there is one.

To migrate an existing Cucumber + Playwright suite, switch one import from
`@cucumber/cucumber` to `nukadoko/compat`. The same pattern syntax, hooks,
and World continue to work while nukadoko's harness starts measuring step
records. A World subclass can assign `this.page` and `this.request`. That
assignment stays unmeasured. Each step can then move to `defineStep` independently, so a
partially promoted suite continues to pass.

The door is an entry point, not a destination. A compat step gains a step
record with status and timing from the first run; evidence and `observed`
counts follow once its glue opens the browser or request through
`this.openPage()` / `this.openRequest()` (the measured upgrade in
[docs/migration.md](docs/migration.md)). However, nukadoko discards its return value, and its
step record contains `result: null`. Features that require a validated
result remain unavailable. `nuka check` has no contract to compare with a
feature, `from` cannot declare a dependency, and a green run summary
confirms only that the steps ran. It does not confirm that stated contracts held. These
limits are the reasons to promote each step.

Switching the import back returns a plain cucumber-js suite. That is a
standing design rule (compat assets must survive both the switch and a
partial migration), and its job is to make trying nukadoko cost one edit
instead of a commitment. It is not a property to build a strategy around.
A step promoted to `defineStep` has no import to switch back: its body
still moves, since `run` is written against Playwright's own objects, but
its schemas and everything built on them do not, and nothing here converts
one back (docs/migration.md "The way back" covers doing it by hand).

The migration cost was measured instead of assumed. An audit compared the
glue from eight public cucumber-js suites with this door but did not run
the suites. **None passed with only the import change** during that audit.
After the identified blockers were fixed, two of the eight had no rejected
glue. The other six still require a short mechanical pass. Each blocker
fails during import or the first run instead of silently changing behavior.

Three of those suites have since been run rather than read, in
[nukadoko-lab](https://github.com/meganemura/nukadoko-lab),
which copies a pinned corpus, rewrites the one import, and runs `nuka run`
against the result. One passed on the import alone. Of the other two, one
now passes: step discovery originally read only `.ts` files, so glue
written as plain `.js` went undiscovered; 0.1.0 widened that to
`.ts`/`.mts`/`.js`/`.mjs`, and the suite has passed on every version the
lab has re-tested since. The other still fails: a file outside its glue
calls a plain `require()`, and discovery walks every file under the
suite's feature directory, not just the ones that register steps, so that
throws mid-import and aborts discovery. `nuka check` tolerates the failure
and names the file; `run` is fail-fast and does not recover. The lab was
last re-run 2026-08-16. Reading glue as text found the blockers that are
visible in glue; executing it found two that were not.

One blocker deserves naming up front, because it is a go/no-go rather than
a pass: **a CommonJS suite cannot use the door at all.**
`require("nukadoko/compat")` fails outright (nukadoko is ESM-only), so a
CommonJS suite needs a module-format change before anything else. Two of
the eight audited suites were CommonJS throughout. This is about the
module format, not the file extension: glue in `.js` or `.mjs` is read
like any other, and a `.cjs` or `.cts` file is named by `nuka check` rather than
turning up later as a step nothing defined.

See [docs/migration.md](docs/migration.md) for the step-by-step guide with
the audit's findings, and
[examples/migration](https://github.com/meganemura/nukadoko/tree/main/examples/migration)
for a worked example running end to end.

Already on Playwright Test, with no cucumber and no Gherkin? That is a
different door, and
[docs/migration-playwright-test.md](docs/migration-playwright-test.md)
walks it: the suite stays where it is and keeps its own runner, while an
operation moves into a plain function that both a spec and a typed step
call.

## Try it against your own suite first

You don't have to migrate anything to find out whether this fits. Point an
agent at your repository with the prompt below; it reports back on your
suite's shape, what a migration would cost, and what could go wrong.

<details>
<summary>Evaluation prompt (paste into an agent working in your repo)</summary>

```
You are evaluating whether to adopt nukadoko (github.com/meganemura/nukadoko)
for this project's end-to-end / acceptance tests.

1. Read nukadoko's README and its full design spec, docs/spec.md, to
   understand what it actually does today versus what is only designed.
2. Survey this project's existing E2E / acceptance test assets: feature
   files (or equivalent scenarios), the glue/step code behind them, and how
   CI runs them.
3. Report back under exactly these five headings, in this order:

1. Current state (what test suite exists today): scope, coverage, what
   executes it.
2. Fit (how typed steps + step records would change the way an agent runs
   this suite's checks): which flows become vocabulary, and what the
   explore-execute-decide loop looks like concretely here.
3. First three migration moves: the first commands to run and the first
   slice of steps to bind (e.g. `nuka init`, binding an initial slice of
   steps, promoting the hottest existing step to a typed one).
4. Risks and costs: an estimate of vocabulary size (how many distinct
   typed steps this suite would need), how much of the existing `Then`
   usage is hygienic (assertion only, nothing chained that mutates) versus
   not, whether the suite is CommonJS, and where secrets currently live
   relative to where nukadoko expects them.
5. Verdict: adopt / trial / not-yet, with the reasoning.

Do not guess at nukadoko internals beyond what its README and docs/spec.md
state. If something is unclear, not yet implemented, or you don't have
access to a document you need, say so rather than assuming.
```

</details>

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

`nuka run` also prints its own progress and where it wrote to stderr as it
goes. stdout stays empty unless you
ask: `nuka run --records` writes each scenario's `run.json` entry there,
one JSON line per scenario as it finishes, and `nuka run --json` prints
`run.json` itself instead, the envelope every `--json` prints with the
run's fields beside `findings`: the commit and whether the tree was dirty,
each environment it ran in, whether a `:line` target made the run
`partial`, the counts, one verdict per scenario and environment, and each
scenario's steps with their line, status, step record,
and, for a failure, its error, the results it read, and the command that
reruns it. Under `--json` stderr is empty, and a warning is a finding in
the document, so the document is the only thing an agent's shell shows.
`run.json` and the step records are on disk in the run's own directory,
`.nukadoko/runs/<run_id>/`, either way, and the run summary is rendered from `run.json` alone. No output depends on whether stdout or
stderr is a terminal.
A failed step prints the first line of its error and the path of its step
record under its progress line, so a CI log says why it failed. When the
failed step read from a step whose program exited nonzero, a `used` line
between the two names that step, its exit code, and the first line of its
stderr: a Then step that got an empty stdout usually failed there. After the
summary, each failed scenario is a `scenario-failed` finding whose `do:`
line runs it again.

```text
  step 2/2  failed  0.0s  the sum is 5
      expected 5, got 4
      record  .nukadoko/runs/<run_id>/steps/<id>
...
failed	scenario-failed	features/sum.feature:3	two and two: expected 5, got 4
  do: nuka run features/sum.feature:3
```

The same facts go into a Markdown run summary, written for a person rather
than a log: `.nukadoko/runs/<run_id>/summary.md` on every run,
appended to `$GITHUB_STEP_SUMMARY` when that is set, and printed again for
any finished run by `nuka report --format markdown` (`--out <path>` for a
PR comment step). Its first line is `<!-- nukadoko:run -->`, so
a CI step can update the comment it posted on an earlier push.

**A retry that replaces the record is out of scope permanently, not "not
yet".** A green scenario is no evidence that its waits are placed
correctly: every wait a scenario needed could have been supplied by
coincidence, further down, and only a route that does not pass through
them can show where they actually belong (see [Design](#design)). A
step record's `polls` field already keeps that honest, distinguishing one
attempt that returned immediately from forty attempts spent waiting 20
seconds; a retry that reruns a whole step until it passes and keeps only
the winning attempt throws that distinction away to buy a green run. That
is the shape ruled out here, the one Playwright's own `retries` and
`testInfo.retry` take, where only the last attempt reaches the final
report. Running a scenario more than once while keeping every attempt's
own record, and naming which attempt passed, is a different shape:
nothing about it makes a record state a fact it cannot support. That shape
is not ruled out, and `nuka run --repeat <n>` ships it (see
the end of this section).

Ruling out the record-discarding shape does not make the flake it would
have papered over disappear. A third-party script or CI-runner resource
contention can fail a scenario whose waits are placed correctly, and
without a retry that failure still turns the run red. A suite that puts
`nuka run` on a merge gate needs a human to triage that failure, because
the fix is not always "the wait was in the wrong place."

`nuka run --concurrency <n>` runs feature files in parallel, with a default
of 1. A full run's wall-clock time falls as concurrency rises, until the
machine runs out of room to add another worker. Measuring where that
happens is worth more than guessing it: on one ten-core machine, four
workers beat eight. The distribution unit is a whole feature file, so the
run cannot divide work within one file, and a suite in few large files
gains less than the same scenarios spread across many. Sharding one suite across
multiple invocations is not available because its records would span
multiple run ids, which no single run summary can describe. Parallel
execution makes `nuka run` faster, but it still starts browsers and remains
the more expensive gate. The split above therefore stays the same: run
`nuka check` on every PR, and run `nuka run` on merge, deploy, or a nightly
build to keep a growing suite's PR gate fast.

`nuka run --repeat <n>` runs every selected scenario `n` times in one
invocation, for a failure that reproduces one time in several. Each
execution is its own record under one run id, and a scenario that failed
at least once is tallied after the summary, `<passed> of <n> passed`.

`nuka run --probe` asks whether each passed Then could have failed. Right
after a read-only Then that captured a value passes, and before the next
step, it runs again, alone, with one capture changed (a string suffixed, a
number +1, a boolean flipped). A Then that still passes is a
`then-passed-with-changed-capture` note in `run.json` and the run summary,
and a Then the probe could not measure (it or its re-run wrote, or its args
schema refused the changed value) is a `then-probe-not-measured` note. It
is a measurement, so the exit code stays the run's.

`nuka run --since <git ref>` says what moved in the criteria since a base
a person approved, such as `origin/main`, as far as its comparison
reaches. Each scenario's criteria (its
tags, its Background and own steps with their effective keyword,
docstrings, and tables, and its Examples row, read from the compiled
scenario so indentation, comments, and a docstring's delimiter do not
count) are compared with the same scenario at that commit, and `run.json`
gives each one `criteria.changed_since`: `unchanged`, `changed`, `new`,
`ambiguous` (scenarios of one name that content cannot pair), or `unknown`
(the file does not parse at the ref). `since` lists the criteria the ref
held that are gone, what was compared (the run's targets: a directory
target brings in the files the ref held under it), and each file that
registers a bound step, its parts, or the fixtures it needs, with whether
git sees it `changed` or `untracked` at the ref. The run summary's
"Criteria since" section quotes every scenario that is not unchanged and
every removed criterion, which is what the reader is asked to approve
again, and lists the scenarios under each changed step file. It reports
only; the exit code stays the run's.

`nuka run --env a --env b` runs every selected scenario once in each
environment, in one run with one run id: all of `a` first, then all of
`b`, each with its own env files, secrets, version probe, BeforeAll and
AfterAll, and process-scope fixtures. `run.json` holds one verdict per
scenario and environment, the summary table has one column per
environment, and the exit code is red when any cell is. A scenario that
passes with a feature flag on and fails with it off reads across one row.
`--env default` names the environment a run without `--env` uses, as
`run.json` names it, so `--env default --env staging` runs both.
An environment is still only config: what differs between `a` and `b` is
whatever their env files and `baseURL` say.

## What this does not do

- **Step records are not unforgeable.** An agent with shell access can write
  any file, step records included: the same honest limit secrets have. What
  nukadoko removes is the need to trust an agent's *account* of a run:
  execution and measurement stay with the tool, not with the agent
  describing them.
- **It does not check that an assertion asserts anything.** Whether a step
  truthfully does what its description claims rests on PR review. The tool
  guarantees the shape of inputs and outputs and the fact of execution. A
  typed contract makes an empty assertion easier to spot in review, but
  nothing rejects one automatically. `nuka run --probe` measures one part
  of it: a read-only Then that still passes with a capture changed is a
  note, never a failure, and a Then the probe catches can still check the
  wrong thing.
- **`mutates` is trusted, not re-derived from what the network shows.**
  Write detection runs on HTTP method as a proxy for write semantics, not
  the semantics itself: purely client-side state and a server that mutates
  on GET are invisible to it, and a step calling a semantically pure read
  implemented over POST (GraphQL, RPC-over-POST, many vendors' query
  endpoints) would count as a write it never made. No general HTTP-layer
  rule can tell those two cases apart, which is why nukadoko stopped
  failing steps on the count. See
  [Keyword semantics](docs/spec.md#keyword-semantics) for the fuller
  argument. The count is still recorded, on the step record and in Allure, so a
  wrong `mutates` declaration is falsifiable after the fact; the
  declaration and review carry the judgment.
- **CommonJS suites cannot use `nukadoko/compat`** without a module-format
  change first (above).
- **No CI reporting or HTML rendering built in.** Allure's dashboard is the
  rendering (above); what does and does not run in CI at all, including
  why retries specifically are not planned, is covered in
  [Running this in CI](#running-this-in-ci).

If a team concludes it does not need the natural-language layer at all
(that whoever decides what to build and whoever writes the checks are the
same people), then Playwright Test directly is a reasonable decision, and
this tool does not argue against it. The case here starts where those two
are different, and gets stronger the more of the implementation is written
by something that cannot be asked why it wrote that.

## The bed has to be tended

A nukadoko is the fermented rice-bran bed that pickles cucumbers. It is
alive: tended daily it matures, neglected it dies. That is the claim this
tool makes about a suite's step definitions (a living culture rather than
a write-once asset), and it is not only a remark about the name.

`nuka check` asks whether the project can run right now, and is meant to be
read before every run. `nuka tend` asks the other question: is any of this
rotting (see [Tending](docs/spec.md#tending)). A step file that failed to
import, so every count silently leaves its steps out. A `from` declaration
nothing exercises. A schema field with no
description reads fine to a person looking at the file and tells the agent
choosing between two steps nothing at all. None of those stop a run, which
is exactly why they needed somewhere else to be said: printed before every
run, they would train everyone to skim past the lines that do stop one.

It opens with where the bed is (how much of the vocabulary is typed rather
than still compat), because that number was previously only visible by
reading a directory of step records, which nobody does.

## Who reads what

A person who approves without writing code reads two things: the
`.feature`, to check it says what the ticket meant, and the run summary,
to check what ran, at which commit, and which criteria and step files
changed since the base they approved, as far as its comparison reaches.
Everything under
`.nukadoko/` and every `nuka` verb belongs to the agent or to CI. Every
`nuka run` writes that summary as Markdown: the commit, each environment,
the browser, one table per feature with each scenario's verdict in each
environment, its duration, and its failing step, a closing section naming any step that declared
`mutates: false` while measured making a write, and the command that reruns
each failed scenario. On GitHub Actions it lands on the job's summary page
with no configuration, and `nuka report --format markdown --out <path>`
writes a copy a CI step can post as a PR comment ([docs/ci.md](docs/ci.md)). nukadoko records the
evidence, not the approval: the summary names the commit it describes, so
an approval recorded anywhere (a pull request review, a change ticket, an
audit log) can point at the run it approved, and nukadoko writes no
approval record of its own (see [Review](docs/spec.md#review)).

## Design

The full design (problem statement, typed steps, keyword semantics,
records, environments and secrets, review, roadmap, and honest
limits) lives in a single place: [docs/spec.md](docs/spec.md).

## License

[MIT](LICENSE)

---

[Japanese](README.ja.md)
