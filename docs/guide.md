# The nukadoko guide

The [README](../README.md) says what nukadoko is, walks a first scenario,
explains how a run is judged, and puts it in CI in one step. This guide
holds the rest of what a project meets while it uses nukadoko. The design
itself is in [spec.md](spec.md).

- [An HTTP API](#an-http-api) and [Calling the program with fetch](#calling-the-program-with-fetch)
- [Setup details](#setup-details), [Upgrading](#upgrading), and [Secrets need no manifest](#secrets-need-no-manifest)
- [Before / after](#before--after) and [What it fixes](#what-it-fixes)
- [Reports fill themselves](#reports-fill-themselves)
- [Self-healing, with the deviation on the record](#self-healing-with-the-deviation-on-the-record)
- [The compat door](#the-compat-door) and [Try it against your own suite first](#try-it-against-your-own-suite-first)
- [CI runs in depth](#ci-runs-in-depth)
- [The bed has to be tended](#the-bed-has-to-be-tended)

## An HTTP API

The program under test is described by the config's `program`, a
function that returns how the program starts. nukadoko starts it for each run
on a free port of its own, waits until it answers, sends every step's
requests there, and stops it after the scenarios:

```ts
// nukadoko.config.ts
import { defineConfig } from "nukadoko";

export default defineConfig({
  program: () => ({
    serve: { command: "node src/server.ts" },
    env: { PORT: "{port}" },
  }),
});
```

`{port}` is the port nukadoko picked, and the program listens where `PORT`
says. The command is split on whitespace and runs with no shell. The
program is ready once `/` answers 2xx; `serve.ready` names another path.
A line on stderr names the URL and `program.log`, which holds what the
program printed, beside the run's records. `port: "auto"`, the default,
picks a free port when the world starts. Two runs at once can still race
for the same one: a server that then cannot listen and exits fails its
world, or, when the other run's server already answered its ready check,
is reported as `program-exited` when the world stops. The same file holds `build` and `prepare` commands, a directory of
its own for each run's database (`{dir}`), and `url` for a server
nukadoko does not start: "Program" in [docs/spec.md](spec.md#program)
has every field. Commit the file beside the config.

Here `src/server.ts` answers `/greet/<name>` with the text
`Hello, <name>!`. With this feature:

```gherkin
# features/greet.feature
Feature: greet API

  Scenario: greets by name
    When I request the greeting for "Ada"
    Then the greeting is "Hello, Ada!"
```

scaffold the When step and its Then, and the scenario runs with no edit.
The When step sends its request through Playwright's `request`, so
install `playwright` too:

```sh
npm install -D -E playwright@1.61.1
npx nuka scaffold get-greeting --pattern "I request the greeting for {name:string}" --request "GET /greet/{name}"
npx nuka scaffold greeting-is --pattern "the greeting is {text:string}" --then --from get-greeting.body
```

`get-greeting` is one ``request.fetch(`/greet/${name}`, { method: "GET" })``
call that returns `status` and `body` (the response text). Each request
lands in the step record's `http.jsonl`.

`--request "<METHOD> <path>"` resolves the path against the program's
URL. Each `{key}` in the path is that args key's value, put in as it is,
and `--body <key>` sends an args key (the line's `docstring`, say) as the
request's data. A value the request does not read throws by name until
it is placed. The step writes `mutates: true`: the method is a proxy for
write semantics, so the author sets `false`.

## Calling the program with fetch

A step can call the program with `fetch` instead, which needs nothing
installed. `baseURL` is the URL of the program nukadoko started, from the
program above:

```ts
// features/steps/get-greeting.ts
import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "GET /greet/<name> from the program under test",
  pattern: "I request the greeting for {name:string}",
  args: z.object({ name: z.string() }),
  returns: z.object({ status: z.number(), message: z.string() }),
  async run({ baseURL }, { name }) {
    const response = await fetch(`${baseURL}/greet/${encodeURIComponent(name)}`);
    const body = (await response.json()) as { message: string };
    return { status: response.status, message: body.message };
  },
});
```

Each call lands in the step record's `http.jsonl` with its request body
and response body, the same as a `request` call.

The Then step comes from `nuka scaffold message-is --pattern "the message
is {text:string}" --then --from get-greeting.message`, the same way
`output-says` came from `run-greet`. The message carries no newline, so
its claim needs no `view` and runs as scaffolded, with no edit. The
feature:

```gherkin
# features/greet.feature
Feature: greet API

  Scenario: greets by name
    When I request the greeting for "Ada"
    Then the message is "Hello, Ada!"
```

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
and `.env.*`, and leaves `.env.example` tracked. The screenshots nukadoko
takes cover a loaded secret the page shows, but traces inside the state
directory are not redacted, so it contains sensitive data.

</details>

## Upgrading

Use `npm install -D nukadoko@latest`. npm writes a caret range during
installation. While the major version is 0, a caret also pins the minor
(`^0.14.1` allows `0.14.x` only; for `0.0.x` it pins the patch), so
`npm update` alone never moves beyond the initially installed minor.
While this is 0.x, any release can change the public API. Read the
[changelog](../CHANGELOG.md) instead of relying on the range for safety.
For what to actually fix after a breaking change, see
[docs/upgrading.md](upgrading.md).

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
  install Playwright at all; see [Install](../README.md#install)). Both hand back
  Playwright's own
  `APIRequestContext` and `Page` objects, not a nukadoko wrapper, so
  existing Playwright knowledge and helpers carry over directly.
- `request.post("/projects", ...)` above resolves that relative path
  against the URL of the program the config's `program` starts or names
  ([An HTTP API](#an-http-api)). Without a program, only an absolute
  URL works.
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
| `this.foo`: an untyped bag | A step returns a value against a `returns` schema; a later step declares `from` to read one key of it by name: a dependency that shows up as an import in the diff, a read that lands on the receiving step's step record, and a binding order `nuka check` verifies before anything runs (see [Chaining steps](spec.md#chaining-steps)) |
| A report that only says `passed` | Every execution writes a step record: validated result, the HTTP calls with their bodies, the processes, and the files the tool itself recorded, what it saw but could not measure, evidence, environment, target version |
| Undefined steps found at run time | `nuka check <feature>` fails on them statically, and names the text that matched nothing |
| A `Then` that judges in code, or quietly acts | A typed `Then` declares claims instead of code: which value it reads, how it compares it, and where the expected value comes from, which is the sentence unless the step says otherwise. nukadoko compares, and the record and the run summary name both values. `nuka check` refuses a `Then` bound to a step that runs, and a claim step bound in `Given` or `When` (see [Claims](spec.md#claims)) |
| A scenario that passes whether or not the feature is there | An environment declares the switches of its program as `conditions`, and a scenario tagged `@with:<switch>` also runs where the switch is off, as a control that never turns the run red. A Then that fails there, at the same line in two runs, makes the row `proven`; a row whose control passed stays `held`, and the run summary's table shows which is which (see [Verdicts](spec.md#verdicts)) |
| A step that quietly mutates state | `mutates` is a declaration nukadoko trusts, not a number it re-derives: a step declaring `mutates: true` is refused before it runs in a read-only environment; what actually ran is still recorded on the step record for review |

The last row requires precision because the tool once failed on a count
instead of the promise. That behavior stated what the measurement could
not support. The count used the HTTP method as a proxy for a write. This
proxy fails for GraphQL, RPC-over-POST, and vendor query APIs that perform
a pure read over POST. A truthful `mutates: false` step that calls one of
these APIs still looks like a write. No general HTTP-layer rule can
distinguish that call from a real write. Nukadoko therefore trusts the
declaration and never infers a write from a method. The step record keeps
each request it measured, with its method, URL, status, and bodies, as a
fact, not a verdict, and it names what it could not measure instead of
guessing.

## Reports fill themselves

A classic Cucumber run shows only the evidence that a team wires up. Each
project must write and maintain hook boilerplate for traces and screenshots.
[Allure](https://allurereport.org/) is a test-report dashboard; nukadoko
writes results in its format and never renders HTML itself.
`nuka report --format allure` fills the report from every step record of a
finished run without additional wiring. It adds
the validated result, trace, HTTP log, environment, and version. One item cannot be added on the report side in
classic Cucumber because Cucumber discards step return values: the
validated result for each step.

Under each step sits a timeline of what happened inside it, built from
absolute timestamps: the stages it reached, every wait with its real
duration and how many attempts it took, and every Playwright call it made
including the assertions. One attempt and forty attempts ask for opposite
fixes, and nothing else in a report tells them apart. Each claim of a
`Then` follows the timeline as a child step of its own, named by its claim
line and passed or failed, with both values and where each came from as
parameters. Counts of what the
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
environments is two test cases of one name there. A control (a
scenario run where its condition does not hold) is left out of the
stream, so JUnit reads a green run as green. It does not read every red
run as red: under `--base` an `unproven` or `moved` row is no failed
test case there, so gate on `nuka run`'s exit code. Allure keeps a
control, named `<scenario> (control)`, with the status it ran to. See
[Allure results](spec.md#allure-results) and
[Messages stream](spec.md#messages-stream).

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
"Product errors" category instead of one of the nine `error.kind` ones. A
project not using `init` can copy
[examples/allure/allurerc.mjs](https://github.com/meganemura/nukadoko/blob/main/typescript/examples/allure/allurerc.mjs)
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
an agent workflow (the bundled skills, in
[Skills for coding agents](../README.md#skills-for-coding-agents)), not
engine magic. See
[Self-healing, audited](spec.md#self-healing-audited).

This loop does **not** catch another way a suite can become hollow. A
scenario can remain intact while its `Then` becomes weaker. A step record
shows what the execution did, and a claim shows what a `Then` compared,
but neither can show whether that comparison still means what the
criterion says. Review must catch that problem, as
[What this does not do](../README.md#what-this-does-not-do) explains.

## The compat door

Nothing before this section assumes an existing suite. This section is for the case
where there is one.

To migrate an existing Cucumber + Playwright suite, switch one import from
`@cucumber/cucumber` to `nukadoko/compat`. The same pattern syntax, hooks,
and World continue to work while nukadoko's harness starts measuring step
records. A World subclass can assign `this.page` and `this.request`. Such
a page gets no trace and no page log, though a request sent through such a
`this.request` from a step still lands in `http.jsonl`. Each step can then move to `defineStep` independently, so a
partially promoted suite continues to pass.

The door is an entry point, not a destination. A compat step gains a step
record with status and timing from the first run; evidence and the page's
`http.jsonl` lines follow once its glue opens the browser or request through
`this.openPage()` / `this.openRequest()` (the measured upgrade in
[docs/migration.md](migration.md)). However, nukadoko discards its return value, and its
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

See [docs/migration.md](migration.md) for the step-by-step guide with
the audit's findings, and
[examples/migration](https://github.com/meganemura/nukadoko/tree/main/typescript/examples/migration)
for a worked example running end to end.

Already on Playwright Test, with no cucumber and no Gherkin? That is a
different door, and
[docs/migration-playwright-test.md](migration-playwright-test.md)
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
   usage only reads and compares (a typed `Then` declares claims, and its
   sentence states the expected value) versus acts or keeps the expected
   value in code, whether the suite is CommonJS, and where secrets currently live
   relative to where nukadoko expects them.
5. Verdict: adopt / trial / not-yet, with the reasoning.

Do not guess at nukadoko internals beyond what its README and docs/spec.md
state. If something is unclear, not yet implemented, or you don't have
access to a document you need, say so rather than assuming.
```

</details>

## CI runs in depth

This section continues [Running this in CI](../README.md#running-this-in-ci)
in the README, after the one step that runs the whole gate.

`nuka run` also prints its own progress and where it wrote to stderr as it
goes. stdout stays empty unless you
ask: `nuka run --records` writes each scenario's `run.json` entry there,
one JSON line per scenario as it finishes, and `nuka run --json` prints
`run.json` itself instead, the envelope every `--json` prints with the
run's fields beside `findings`: the commit and whether the tree was dirty,
each environment it ran in, whether a `:line` target or `--tag` made the run
`partial`, the counts, the verdict table (one row per criterion, one cell
per environment, and each row `held`, `proven`, or `failed`), and each
scenario's steps with their line, status, step record, a claim step's
claims,
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
stderr: a Then that claimed against an empty stdout usually broke there. After the
summary, each failed scenario is a `scenario-failed` finding whose `do:`
line runs it again.

```text
  step 2/2  failed  0.0s  the sum is 5
      claim broken: 4 (from:add@4.sum) equal 5 (sentence:expected)
      record  .nukadoko/runs/<run_id>/steps/<id>
...
failed	scenario-failed	features/sum.feature:3	two and two: claim broken: 4 (from:add@4.sum) equal 5 (sentence:expected)
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
them can show where they actually belong (see [spec.md](spec.md)). A
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
the more expensive gate. The split in
[Running this in CI](../README.md#running-this-in-ci) therefore stays the same: run
`nuka check` on every PR, and run `nuka run` on merge, deploy, or a nightly
build to keep a growing suite's PR gate fast.

`nuka run --repeat <n>` runs every selected scenario `n` times in one
invocation, for a failure that reproduces one time in several. Each
execution is its own record under one run id, and a scenario that failed
at least once is tallied after the summary, `<passed> of <n> passed`.

`nuka run --order shuffled` runs the same selection in an order a seed
names, for a scenario that passes only because an earlier one left data in
the program. The feature files are sorted, then each file's scenarios, so
a file stays whole at any `--concurrency`. The seed is on stderr, in
`run.json`, and in the summary, and `--order shuffled:<seed>` runs that
order again. A failed scenario's `do:` line names the scenarios that ran
before it, so an order dependence fails on it again, where running the
scenario alone would pass. File order stays the default.

`nuka run --env a --env b` runs every selected scenario once in each
environment, in one run with one run id: all of `a` first, then all of
`b`, each with its own env files, secrets, version probe, program,
BeforeAll and AfterAll, and process-scope fixtures. `run.json` holds the
verdict table, one row per criterion and one cell per environment, and the
summary opens with it. An environment can declare the switches of its
program as `conditions`, and a run without `--env` runs every
environment that declares them, or the ones the program's
`defaultEnvironments` names:

```ts
env: { BANNER: "{condition.banner}" },
environments: {
  "banner-off": { conditions: { banner: false } },
  "banner-on": { conditions: { banner: true } },
},
```

A scenario tagged `@with:banner` is required in `banner-on` and a
control in `banner-off`. A control never turns the run red. When its Then
fails, at the same line in two runs (`--proof-runs`), the row is
`proven`: the scenario tells the two sides of the switch apart. When it
passes, the row is `held`, and that is the row to read: the Then does not
see what the switch changes. A row is `failed`, and the exit code 1, when
a required cell does not pass. `--env default` names the top-level
environment, as `run.json` names it, so `--env default --env staging`
runs both. An environment is still only configuration, in the
program: what differs between `a` and `b` is whatever
their fields say. `conditions` sets nothing, and nukadoko does not check
it against the program: `{condition.banner}` hands the program the side
its environment declares, so the two cannot disagree.

`nuka run --base <git ref>` compares each criterion with the commit the
ref names, such as `origin/main`, and adds two worlds where a row needs
them. A criterion is its feature file and name, and its content is what a
person approved (its steps, its Examples row, its condition tags), so a
renamed or retagged scenario stays `unchanged`. A `new` or `changed`
one also runs in the `base` world, the base's code under head's
criteria and steps, and its Then has to fail there, in each of two runs,
for the row to be `proven`; when nothing shows that, the row is
`unproven`, and `@held` says the base already had the behaviour. When
the mapping changed (a step file or helper under the features directory,
the config's fixtures or parameter types, an environment's conditions),
an `unchanged` one also runs in the `old` world, head's code under the
base's criteria and steps, and has to pass there; when it does not, the
row is `moved`: the approved sentence no longer means what it meant.
Each world runs in a tree under the run directory, built from that
tree's program, and resolves packages from head's project. The exit
code is 1 on a `failed`, `unproven`, or `moved` row, and a `removed`
row quotes the criterion that went. In a shallow clone, fetch the base
first; the refusal names the command.

## The bed has to be tended

A nukadoko is the fermented rice-bran bed that pickles cucumbers. It is
alive: tended daily it matures, neglected it dies. That is the claim this
tool makes about a suite's step definitions (a living culture rather than
a write-once asset), and it is not only a remark about the name.

`nuka check` asks whether the project can run right now, and is meant to be
read before every run. Its notes ask the other question: is any of this
rotting (see [Checks and notes](spec.md#checks-and-notes)). A `from`
declaration nothing exercises. A pattern no feature binds. A schema field
with no description reads fine to a person looking at the file and tells
the agent choosing between two steps nothing at all. None of those stop a
run, so a note never changes the exit code; a job that wants one to gate
names its code with `nuka check --fail-on`. Only a check with no target
reports notes, because whether a step is bound depends on every feature the
project scans.

---

[Japanese](guide.ja.md)
