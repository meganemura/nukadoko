# nukadoko

[![npm version](https://img.shields.io/npm/v/nukadoko)](https://www.npmjs.com/package/nukadoko)

> Implementations are generated now. What checks them cannot be. Typed step
> contracts and tool-measured step records between natural-language
> acceptance criteria and what actually ran.

nukadoko runs Gherkin scenarios under typed step contracts and writes a
step record for every execution. The tool measures this record instead of
relying on an agent's report. The criteria remain in the language used by
the people who set them. Everything between those sentences and the system
under test is typed, checked before execution, and reviewable in a diff.

## Install

Node 20+ (`package.json`'s `engines.node` is `">=20"`).

```sh
npm install -D nukadoko
npx nuka init          # writes nukadoko.config.ts (or .mts, see below) and .nukadoko/ ignores
npx nuka steps         # the vocabulary, empty until you add a step
```

nukadoko is a devDependency. It ships its TypeScript source alongside
`dist/`, so stack traces point to the actual code. An agent reading
`node_modules` can see why something works, not only its type.

If an existing `package.json` has no `"type": "module"`, the project uses
CommonJS, as a plain `npm init -y` does. `nuka init` still works. It writes
`nukadoko.config.mts` instead of `nukadoko.config.ts` and prints a one-line
reminder that step files also need `.mts`. In such a project, Node reads a
plain `.ts` file as CommonJS, while nukadoko supports only ESM.

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
paragraph above). However, manually writing `nukadoko.config.ts` in such a
project fails with `No "exports" main defined in
.../node_modules/nukadoko/package.json`. `nuka init` writes
`nukadoko.config.mts` instead. You do not need to add `.nukadoko/` to
`.gitignore` yourself because `nuka init` does that. Traces and screenshots
inside it are not redacted, so the state directory contains sensitive data.

</details>

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

The entry appears under `steps`, one field of `{ steps, import_failures }`.
The `import_failures` field names each step file that the call could not
import. This field is always present and is empty when all imports succeed.

Before anything runs, `nuka check` reads every feature file and step file,
then reports each problem. An undefined step is the simplest case. No step
definition matches the line's text, so `check` identifies the exact line
before a run can reach it.

```
error	undefined-step	features/todo.feature:7	No step definition matches "the todo titled "Walk the dog" is completed"; run `nuka scaffold <name>` to add one
```

A from-order violation is the case plain glue cannot even represent,
because without a typed contract there is nothing for the concept to
attach to. Step B declares `from` to read a value step A returned; here the
feature binds B before A has run anywhere in the scenario, and `check`
catches it before either step executes:

```
error	from-order-violation	features/chain.feature:11	Step "archive-project"'s from.projectId needs step "create-project" to have already run earlier in this scenario, but "create-project" is never bound anywhere in this scenario. This line would fail args validation with certainty
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
  "status": "ok",
  "observed": { "http_reads": 0, "http_writes": 1 }
}
```

(`evidence`, `environment`, `session`, and the timestamps are trimmed above
for space; the real step record has them too.)

An existing cucumber-js suite reaches this door too, by switching one
import (see [The compat door](#the-compat-door) below). But a compat step
has no typed contract, so `nuka check` has nothing here to hold a feature
line against, and `nuka do` refuses to run one by name at all.

`check` is the cheap static gate; `run` leaves the step record trail; `accept`
freezes one green run as a committed record beside its feature; `tend` is
the periodic one, and the only one you are meant to *not* run before every
change.

The acceptance record is a Markdown file named
`<feature-filename>.<date>-<sha>.<environment>.<browser>.md`, written beside
the feature, where a listing shows it right after that feature. It contains the full feature text, the scenario record, and
each step record with its evidence removed. It also contains a
`Declared vs observed` section. This section lists each step that declared
`mutates: false` but was measured making a write. A reviewer can therefore
see each disagreement without deriving it again. A sign-off applies to one
`(environment, browser)` pair measured during the run, not to a declared
pair. A state in which Chromium is accepted but firefox is not yet accepted
is normal, not stale. See
[Sign-off](docs/spec.md#sign-off).

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

Implemented and covered by tests: typed steps, step records, sessions,
environments, secrets, `nukadoko/compat`, the Allure and cucumber-messages
emitters, sign-off (`nuka accept`), tending (`nuka tend`), scenario
harvesting (`nuka harvest`), the MCP tool listing (`nuka mcp-tools`), and
two agent skills. Not implemented: an AI-assisted glue converter. See the
[roadmap](docs/spec.md#roadmap).

Maintenance is one person working in the open. Every claim below that
carries a number was measured; where something was only reasoned about,
this README says so.

## Upgrading

Use `npm install -D nukadoko@latest`. npm writes a caret range during
installation. For a `0.0.x` version, a caret also pins the patch, so
`npm update` alone never moves beyond the initially installed version.
While this is 0.x, any release can change the public API. Read the
[changelog](CHANGELOG.md) instead of relying on the range for safety.
For what to actually fix after a breaking change, see
[docs/upgrading.md](docs/upgrading.md).

## Secrets need no manifest

Point `envFiles` at the existing env files, and git classifies them. An
untracked file is a secret source, so every value it defines is redacted
from logs and step records. A tracked file is plain configuration and stays
unchanged. No manifest or manual copy into a second file is required.

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
  never launches a browser. Both hand back Playwright's own
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
still counts every non-GET call made through its request context and page,
but the step record presents the count as a fact, not a verdict.

## Reports fill themselves

A classic Cucumber run shows only the evidence that a team wires up. Each
project must write and maintain hook boilerplate for traces and screenshots.
[Allure](https://allurereport.org/) is a test-report dashboard; nukadoko
emits results in its format and never renders HTML itself. The emitter
fills the report from every step record without additional wiring. It adds
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

A cucumber-messages (NDJSON) emitter ships alongside it so a migrating
team's existing formatters and JUnit-based CI keep working: confirmed by
running our own stream through `@cucumber/junit-xml-formatter`, not just
asserted. See [Allure emitter](docs/spec.md#allure-emitter) and
[Messages emitter](docs/spec.md#messages-emitter).

Both emitters run with zero configuration; there is no flag to turn
either on. The `allure` and `messages` keys in `nukadoko.config.ts`
only move where their output lands, from the defaults
`.nukadoko/export/allure-results` and `.nukadoko/export/messages.ndjson`.

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

`nuka init` writes `allurerc.mjs` at the project root (skipped, with a
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

Use `watch` while iterating. Leave it running in one terminal and run
`nuka run` in another. Temporary scenario snapshots update the report
after each completed step. The final result replaces their live view when
the scenario ends. `watch` serves on a random port (`--port` selects one)
and opens a browser only with `--open`. `nuka init` creates
`.nukadoko/export/allure-results/` so `watch` can start before the first
`nuka run`. See [Allure emitter](docs/spec.md#allure-emitter) for the
snapshot mechanics and the live retry display.

Completed files in `allure-results/` are never rewritten. A run's files
leave with the run once it is older than the newest `retention.runs` runs
(default 20), so a report shows that many runs; `nuka clean --export`
empties the directory at once. Temporary `*-progress-result.json` files
are removed when their scenario ends and when the next run starts.

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
   repaired scenario running green: a scenario record and its step records,
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
  committed record: read the vocabulary, scaffold what's missing, write the
  feature, run it green, `nuka accept` it.
- **migration.** Moves a cucumber-js suite across in two stages, and
  explains which differences are the point rather than listing recipes.

```sh
gh skill install meganemura/nukadoko --all   # both, on any Agent Skills host
nuka skill path                              # the copy matching your installed version
```

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
records. Each step can then move to `defineStep` independently, so a
partially promoted suite continues to pass.

The door is an entry point, not a destination. A compat step gains a step
record with status and timing from the first run; evidence and `observed`
counts follow once its glue opens the browser or request through
`this.openPage()` / `this.openRequest()` (the measured upgrade in
[docs/migration.md](docs/migration.md)). However, nukadoko discards its return value, and its
step record contains `result: null`. Features that require a validated
result remain unavailable. `nuka check` has no contract to compare with a
feature, `from` cannot declare a dependency, and a sign-off confirms only
that the steps ran. It does not confirm that stated contracts held. These
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
like any other, and a `.cjs` file is named by `nuka check` rather than
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
is an excerpt. [docs/ci.md](docs/ci.md) contains a complete workflow and
the four items that projects moving from `npx playwright test` usually add
manually.

```yaml
# excerpt from a CI workflow
- run: npx nuka check              # PR gate: static, seconds, no browser
- run: npx nuka run features/      # merge/deploy gate: executes, writes step records
```

Put `nuka check` on every PR: it is the cheap gate, and it can fail before
anything runs. Put `nuka run` on the gate that actually has to be true,
merge or deploy, since that is the one that executes and leaves a step record
trail behind.

`nuka run` also prints its own progress and where it wrote to stderr as it
goes (`--quiet` quiets the progress only); stdout stays NDJSON either way.

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
is not ruled out; nukadoko just does not ship a way to do it today, so
read this as a boundary on the shape a future feature would have to take,
not an announcement of one.

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
multiple run ids, which `nuka accept` cannot read as one run. Parallel
execution makes `nuka run` faster, but it still starts browsers and remains
the more expensive gate. The split above therefore stays the same: run
`nuka check` on every PR, and run `nuka run` on merge, deploy, or a nightly
build to keep a growing suite's PR gate fast.

`nuka run --repeat <n>` runs every selected scenario `n` times in one
invocation, for a failure that reproduces one time in several. Each
execution is its own record under one run id, and a scenario that failed
at least once is tallied after the summary, `<passed> of <n> passed`.

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
  nothing rejects one automatically.
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
rotting (see [Tending](docs/spec.md#tending)). A sign-off whose frozen
result no longer passes its step's current schema, so the record is still
counted while no longer meaning what it
says. A `from` declaration nothing exercises. A schema field with no
description reads fine to a person looking at the file and tells the agent
choosing between two steps nothing at all. None of those stop a run, which
is exactly why they needed somewhere else to be said: printed before every
run, they would train everyone to skim past the lines that do stop one.

It opens with where the bed is (how much of the vocabulary is typed rather
than still compat), because that number was previously only visible by
reading a directory of step records, which nobody does.

## Who reads what

A person who approves without writing code opens two files in a PR: the
`.feature`, to check it says what the ticket meant, and the sign-off `.md`
beside it, to check what ran and at which commit. Everything under
`.nukadoko/` and every `nuka` verb belongs to the agent or to CI. The
sign-off record is written for that first reader: the feature's own text,
one summary table per scenario, and a closing section naming any step
that declared `mutates: false` while measured making a write, with the
count of those steps already stated in the Condition section at the top.

## Design

The full design (problem statement, typed steps, keyword semantics,
records, sessions/environments/secrets, sign-off, roadmap, and honest
limits) lives in a single place: [docs/spec.md](docs/spec.md).

## License

[MIT](LICENSE)

---

## Japanese

Design (Japanese): [docs/spec.ja.md](docs/spec.ja.md)

> 実装は、いま生成されるようになった。
> それを検査するものは、そうであってはならない。
> 自然言語の受け入れ基準と、実際に走ったものとのあいだをつなぐ、型付き step の契約とツールが計測する step record。

nukadoko は、型付き step の契約のもとで Gherkin の scenario を実行し、実行ごとに step record を書きます。
この record は agent の報告に頼らず、ツールが計測します。
受け入れ基準は、それを定めた人たちが使う言語のまま残ります。
その文と検証対象のシステムとのあいだにあるものはすべて型を持ち、実行前に検査され、diff でレビューできます。

## Install

**インストール**

Node 20+(`package.json` の `engines.node` は `">=20"`)。

```sh
npm install -D nukadoko
npx nuka init          # writes nukadoko.config.ts (or .mts, see below) and .nukadoko/ ignores
npx nuka steps         # the vocabulary, empty until you add a step
```

nukadoko は devDependency です。
`dist/` と並べて TypeScript のソースも同梱しているため、stack trace は実際のコードを指します。
`node_modules` を読む agent は、型だけでなく「なぜそう動くか」も確認できます。

既存の `package.json` に `"type": "module"` が無い場合、そのプロジェクトは CommonJS を使います。
ふつうの `npm init -y` もこの形を書きます。
`nuka init` はそれでも動きます。
`nukadoko.config.ts` の代わりに `nukadoko.config.mts` を書き、step ファイルも `.mts` にする必要があることを 1 行で伝えます。
このようなプロジェクトでは、Node はふつうの `.ts` ファイルを CommonJS として読みますが、nukadoko は ESM だけをサポートします。

<details>
<summary>まだ `package.json` がありませんか(Rails、Django など Node 以外のリポジトリ)?</summary>

先に作成してください。
`npm init -y` は避けてください。
既存の `README.md` の最初の行を `description` に、ディレクトリ名を `name` にコピーしてしまいます。
最小限を手で書くほうが確実です:

```json
{ "private": true, "type": "module" }
```

`"type": "module"` を付けると、生成されるファイルはすべて `.ts` のままになり、上の 2 つの経路のうち簡単な方を使えます。
省略してもサポートされます(上の CommonJS の段落を参照)。
ただし、このようなプロジェクトで `nukadoko.config.ts` を手で書くと、`No "exports" main defined in .../node_modules/nukadoko/package.json` で失敗します。
代わりに `nuka init` は `nukadoko.config.mts` を書きます。
`.nukadoko/` を自分で `.gitignore` に追加する必要はありません。
`nuka init` が追加します。
中の trace とスクリーンショットは redact されないため、state directory には機密データが含まれます。

</details>

## Wrong before it runs

**実行する前から間違っている**

Gherkin は、受け入れ基準を実行可能な scenario として述べます: `.feature` ファイルの中の `Given` / `When` / `Then` の行であり、各行の裏にあるコードは別に書きます。
これらのキーワードはこのプロジェクトのものではなく Cucumber のものであり、その定義は [Cucumber 自身の Gherkin リファレンス](https://cucumber.io/docs/gherkin/) にあります。
nukadoko はこの形式を Cucumber 自身のパーサで読みます。

```gherkin
Feature: Projects

  Scenario: A new project appears in the list
    Given a project "acme" exists
    Then the project list includes "acme"
```

その行の裏にある語彙を調べるために、ソースを読む必要はありません。
`nuka steps --json` が機械可読な形で一覧にします。
agent の探索ループも、この呼び出しから始まります。
このリポジトリの `examples/todo` には、小さな語彙が入っています。
その出力には次の項目があります:

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

この項目は、`{ steps, import_failures }` の一方のフィールドである `steps` の下にあります。
`import_failures` は、この呼び出しが import できなかった各 step ファイルを名指しします。
このフィールドは常に存在し、すべての import が成功すれば空です。

何かが実行される前に、`nuka check` があらゆる feature ファイルと step ファイルを読み、各問題を報告します。
未定義の step は、最も単純なケースです。
どの step 定義もその行のテキストに一致しないため、run がたどり着く前に `check` がその行を名指しします。

```
error	undefined-step	features/todo.feature:7	No step definition matches "the todo titled "Walk the dog" is completed"; run `nuka scaffold <name>` to add one
```

`from` の束縛順序違反は、ふつうの glue には表現すらできない種類のケースです。
型付きの契約がなければ、この概念がつなぎ留まる先自体がないからです。
step B が `from` を宣言して step A の返り値を読むとして、この feature では A がその scenario のどこでもまだ実行されていないうちに B が束ねられており、どちらの step も実行されるより前に `check` がそれを検出します:

```
error	from-order-violation	features/chain.feature:11	Step "archive-project"'s from.projectId needs step "create-project" to have already run earlier in this scenario, but "create-project" is never bound anywhere in this scenario. This line would fail args validation with certainty
```

この 2 つのケースは一例にすぎません。
`nuka check --codes` は、既知の finding code を 1 行の説明つきで一覧にし、「何を捕まえられるか」に答えます。
この README には、新しい code が増えると古くなる件数を書きません。

1 つの step を単独で実行するために scenario は必要なく、実行後に何が残るかを確認できます。
結果は pass/fail の 1 行ではなく、step record です。

```json
{
  "step_record_id": "step-20260804-224640-50lp",
  "step": "add-todo",
  "kind": "do",
  "args": { "title": "Buy milk" },
  "result": { "id": "5c07a3aa-d06a-4421-a708-9d69d8a238e3", "title": "Buy milk", "done": false },
  "status": "ok",
  "observed": { "http_reads": 0, "http_writes": 1 }
}
```

(`evidence`、`environment`、`session`、および各種タイムスタンプは、上では紙面の都合で省いています。
実物の step record にはそれらも入っています。)

既存の cucumber-js のスイートも、import を 1 つ切り替えるだけでこの扉に届きます(下の [The compat door](#the-compat-door) を参照)。
ただし compat の step には型付きの契約がなく、`nuka check` にはここで feature の行を突き合わせる相手がありません。
`nuka do` は、そうした step を名前で実行することを一切拒否します。

`check` は安価な静的ゲートであり、`run` は step record の証跡を残し、`accept` は 1 回の green な実行を feature の隣に置く記録として凍結し、`tend` は定期的に行うものであり、あらゆる変更の前に *run しない* ことが意図されている唯一のものです。

acceptance record は `<feature-filename>.<date>-<sha>.<environment>.<browser>.md` という名前の Markdown ファイルで、feature の隣に書かれます。
一覧では、その feature の直後に並びます。
このファイルには feature の全文、scenario record、そして evidence を取り除いた各 step record が入ります。
さらに `Declared vs observed` という節があり、`mutates: false` と宣言しながら書き込みを行ったと計測された各 step を一覧にします。
これにより、レビュアーは宣言と計測の食い違いを自分で導き直さずに確認できます。
sign-off は、宣言された組ではなく、run 中に計測された 1 組の `(environment, browser)` に適用されます。
Chromium は accept 済みで firefox はまだ、という状態は正常であり、古びた状態ではありません。
詳しくは [Sign-off](docs/spec.ja.md#sign-off) を参照してください。

## Why this exists now

**いま、これが存在する理由**

コードは、ますますこの文と同じような書かれ方をするようになっている。
誰かが欲しいものを説明し、モデルがそれらしいものを生成する。
それはうまく機能するし、そのことによって「検証済み」が意味すべきことも変わる。
実装が確率的に生成されるとき、それを正しいと呼ぶには、生成される *前に* 固定されていて動かない何かが要る。
そうでなければ、検査される側と検査する側が、同じ分布から引かれていることになる。

受け入れ基準は、すでに固定されたものです。
ソフトウェアが何のためのものかを決める人たちが、すでに自然言語で書いています。
欠けていたのは、その言葉を守らせる方法です。
書かれた一文は、起きたか起きなかったかのどちらかである実行へ対応づけられなければなりません。
その対応づけは、出来上がったものへ黙って同意するようにはずれない強度が必要です。

それが、これの正体である。
あらゆる step は型付きの契約であり(境界でバリデーションされるスキーマ、宣言され実行前に検査される依存関係)、あらゆる実行は、agent ではなくツールが書いた記録を残す。
自然言語の側は柔らかいままにしてある。
人がそこで考える場所だからだ。
その下にあるマッピングは意図的に硬くしてある。
保証を運べるのはその部分だけだからだ。

Gherkin は、これが守るものではない。
これが拠って立つ土台である。
自然言語で受け入れ基準を述べる形式は、そのパーサや、ツール群や、教わらずに読める世代の人々ごと、すでに存在している。
同じ主張をするために、その語彙を再発明するのは虚栄だっただろう。
ここに Cucumber への郷愁はない: 保証を運べなかった部分、すなわち型のない glue、`passed` としか言わない報告、そして実行時には何も意味しないキーワードこそが、これが置き換える部分そのものである。

## Agent-first is a design constraint, not a slogan

**agent-first はスローガンではなく、設計上の制約**

agent は、介助なしにループ全体を完了できなければなりません。
まず語彙を発見し(`nuka steps --json`)、契約を読みます(`nuka describe`、スキーマは JSON Schema です)。
次に 1 つの step を実行し(`nuka do`、step record は stdout に出力され、exit code は意味を持ちます)、バリデーション済みの result を読み、次の呼び出しを選びます。
語彙に操作が欠けているときは、agent が新しい step を scaffold して実装します。
その後、人間が PR をレビューします。

その制約が、この設計の大部分を生み出しました。
step は単独で実行できる必要があるため、依存関係は World ではなくシグネチャに現れます。
これにより、`this.foo` でデータフローを隠すこともできません。
次の呼び出しが result を読めるように、ツールは result を捨てずにバリデーションします。
agent の報告は run の記録にならないため、ツールが step record を書きます。
これらの性質は、agent と人の両方に役立ちます。
agent が動かせるスイートは、人もデバッグできるスイートです。

それはまた、この設計がどこへ伸びていくかも決めている。
end-to-end の実行には、ブラウザと分単位の時間というコストがかかる。
そのため、scenario のどれだけを実行せずに誤りだと判定できるかが、誰にとっても反復の速さをそのまま決める。
agent にとっては、そのループが安価なコマンドでできている分だけ、それがそのまま、自分の作業をどれだけ速く正せるかになる。
ここでのあらゆる宣言は、その代価の一部をそうやって支払っており、実行が失敗するたびに立ち返る問いは、`nuka check` がそれをもっと前に捕まえられなかったか、である。

すべてが機械可読な形(`--json`)を持ちます。
リッチな人間向けレポートは Allure に委ねられます。

## Status

**現況**

**0.x です。**
1.0 になるまで、public API はどのリリースでも変わり得ます。
これは 0.x の全区間に当てはまるのであって、0.1 で終わる話ではありません。
0.1 に到達するのは roadmap がより多く実現されたという意味であって、公開面が凍結されたという意味ではありません。

テストで実装済みかつカバーされているのは、型付き step、step record、session、environment、secret、`nukadoko/compat`、Allure と cucumber-messages の emitter、sign-off(`nuka accept`)、tending(`nuka tend`)、scenario の harvesting(`nuka harvest`)、MCP のツール一覧(`nuka mcp-tools`)、そして 2 つの agent skill です。
未実装なのは、AI 支援によるグルーの変換です(詳しくは [roadmap](docs/spec.ja.md#ロードマップ) を参照してください)。

メンテナンスは 1 人が公開の場で行っています。
以下で数字を伴う主張はすべて計測済みです。
推測にとどまるものについては、この README がその旨を書きます。

## Upgrading

**アップグレード**

`npm install -D nukadoko@latest` を使ってください。
インストール時に npm はキャレット範囲を書きます。
`0.0.x` のバージョンではキャレットが patch も固定するため、`npm update` だけでは最初に入れたバージョンを超えません。
0.x の間はどのリリースでも public API が変わり得ます。
範囲指定に頼らず、[changelog](CHANGELOG.md) を読んでください。
破壊的変更のあとに実際に何を直すかは、[docs/upgrading.ja.md](docs/upgrading.ja.md) を参照してください。

## Secrets need no manifest

**secret に manifest は要らない**

既存の env file を `envFiles` に指定すると、git が分類します。
追跡されていないファイルは secret source となり、そこで定義された各値はログと step record から伏せられます。
追跡されているファイルは平文の設定であり、変更されません。
manifest も、別のファイルへの手作業によるコピーも必要ありません。

## Before / after

**移行前 / 移行後**

regex のグルーコードを型付きの step に昇格させる例です。
feature 行のテキスト自体は変わりません。
変わるのはその背後にある step の定義だけです。

Before(cucumber-js、位置キャプチャ、型なし、World への stash):
World は、cucumber-js があらゆる step に与える、scenario ごとの `this` オブジェクトです。

```ts
// features/steps/project.ts (cucumber-js)
import { Given } from "@cucumber/cucumber";

Given("a project {string} exists", async function (name: string) {
  const res = await this.request.post("/projects", { data: { name } });
  const body = await res.json();
  this.project = body; // stashed on World — no schema, no type
});
```

After(`defineStep`、named capture、zod、step record 付き):

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

- named capture(`{name:string}`)は、値を名前で `args.name` に結び付けます。位置キャプチャでは、同じ型の値 2 つを pattern 内で入れ替えると、どちらの値がどこに入るかが黙って入れ替わります。`nuka check` は、それが起きる前に、裸の `{string}` もエラーとして検出します。
- `args` と `returns` は、実行境界でバリデーションされる zod のスキーマです。step record の `result` は、step が返しただけのものではなく、ツールがバリデーション済みのものです。
  上の `z` は nukadoko 自身から来るので、zod を別途インストールする必要はありません。
  自分のプロジェクトですでに zod を使っていて、そちらのスキーマを渡す場合は、そのスキーマが zod 4 である必要があります。
- 上の `request`(そして browser の step 向けの `page`)は、`run` の第一引数である fixture bag から直接分割代入されたものです。
  step が実際に分割代入した名前だけが構築されるため、`page` を一度も名指ししない step はブラウザを起動しません。
  どちらも返すのは Playwright 自身の `APIRequestContext` と `Page` のオブジェクトであり、nukadoko 独自のラッパーではありません。
  そのため既存の Playwright の知識とヘルパーはそのまま持ち込めます。
- 上の `request.post("/projects", ...)` は、その相対パスを `nukadoko.config.ts` 自身の `baseURL` に対して解決します(`URL` が大文字である点は Playwright 自身のキーと同じです)。
  未設定のままだと、絶対 URL しか通りません。
- `nuka do create-project --args '{"name":"acme"}'` は、この step だけを実行して step record を出力します。
  この record は agent の探索ループを構成する単位であり、事前の準備は不要です。

## What it fixes

**何を直すのか**

どの行も、文と実行のあいだの対応づけがかつて緩んでいた場所です。
cucumber-js を引き合いに出しているのは、そこが最もなじみ深い場所だからであって、それだけがこの緩みを持つ層だからではありません。

| The failure | What nukadoko does about it |
|---|---|
| 重複する step(どれが一致したか分からない) | `nuka check` は、何かが実行される前に、同じテキストが 2 回登録されている **duplicate patterns** と、feature の 1 行に異なる 2 つの pattern がどちらも一致し得る **ambiguous steps** を報告します |
| `this.foo`(型のない袋) | step は `returns` スキーマに対して値を返し、後続の step はそのうち 1 つのキーを名前で読むために `from` を宣言します。この依存関係は diff 上で見える import として現れ、読んだ事実は読み手側 step の step record に記録され、束縛の順序が壊れていれば `nuka check` が実行前に検出します(参照: [Chaining steps](docs/spec.md#chaining-steps)) |
| `passed` としか言わない報告 | あらゆる実行が、バリデーション済みの result、ツール自身が観測したネットワークの読み書き、evidence、environment、target version を記録した step record を書きます |
| 実行時に見つかる undefined な step | `nuka check <feature>` はそれらを実行前に静的に検出して失敗し、何にも一致しなかったテキストの名前を挙げます |
| 黙って状態を変える `Then` | `mutates` は nukadoko が信頼する宣言であり、計測から導き直す数値ではありません。`mutates: true` を宣言した step は、read-only な environment では実行前に拒否され、`Then` に結び付けられていれば `nuka check` が警告します。実際に何が起きたかは、レビューのためにいまも step record に記録されます。 |

最後の項目には、正確な説明が必要です。
このツールはかつて、約束ではなく計測された回数に対して失敗していました。
この挙動は、計測が支えられない主張をしていました。
書き込みの検出は HTTP メソッドをプロキシとして使います。
このプロキシは、GraphQL、RPC-over-POST、純粋な読み取りを POST 上に実装するベンダーの query API では破綻します。
そうした API を呼ぶ正直な `mutates: false` の step も、書き込みに見えます。
一般的な HTTP レイヤーのルールでは、その呼び出しと本物の書き込みを区別できません。
そこで nukadoko は宣言を信頼します。
自身の request context と page を通じて行われた非 GET の呼び出しはいまも数えますが、step record はその回数を断定ではなく事実として示します。

## Reports fill themselves

**レポートはひとりでに埋まる**

従来型の Cucumber の実行は、チームが自分で仕込んだ evidence だけをレポートに映します。
各プロジェクトが、trace やスクリーンショットのための hook の boilerplate を書いて保守します。
[Allure](https://allurereport.org/) はテストレポートのダッシュボードで、nukadoko はその形式で結果を emit するだけで、HTML 自体は決してレンダリングしません。
emitter は、追加の設定なしで、あらゆる step record からレポートを満たします。
バリデーション済みの result、trace、HTTP log、observed な読み書き、environment、version を追加します。
そのうち、各 step のバリデーション済み result は、従来型の Cucumber ではレポート側から追加できません。
Cucumber が step の返り値を捨てるためです。

各 step の下には、絶対時刻から組み立てられた、その内部で何が起きたかのタイムラインが置かれます。
到達した段階、それぞれの待ちの実際の所要時間と試行回数、そして assertion を含めて実行された Playwright の呼び出しのすべてです。
1 回の試行と 40 回の試行では直し方が正反対になりますが、それを見分けられるのはレポートの中でここだけです。
ページ自身が述べたこと(console error、捕捉されないエラー、失敗したリクエスト)の件数が step のそばに置かれるので、ページが 3 件の捕捉されないエラーを投げながら通った step は、誰も attachment を開かなくてもそれを語ります。
添付される trace はその step 自身のものであり scenario 全体のものではないため、失敗した step はさがし回らずに直接開けます。
同じ `trace.zip` は step record の下にも単体で置かれており、Allure を介さずに `npx playwright show-trace <evidence.dir>/trace.zip` で直接開けます。
step record も全文がそのまま添付され、それがこの一覧を古びさせずにいる理由です。
step record が後から何を得ても、2 つ目の対応表を覚える必要なくレポートに届きます。

あわせて cucumber-messages(NDJSON)の emitter も同梱されており、移行するチームの既存フォーマッタと JUnit ベースの CI をそのまま動かし続けます。
これは単なる主張ではなく、自前のストリームを `@cucumber/junit-xml-formatter` に通して確認済みです。
[Allure emitter](docs/spec.ja.md#allure-emitter) と [Messages emitter](docs/spec.ja.md#messages-emitter) を参照してください。

どちらの emitter も設定ゼロで動き、有効化するためのフラグはありません。
`nukadoko.config.ts` の `allure` と `messages` は、出力先を既定の `.nukadoko/export/allure-results` と `.nukadoko/export/messages.ndjson` から移すだけのキーです。

nukadoko が書くのは結果であって HTML ではないため、それを描画するのは Allure 3 の CLI です(`npm i -g allure`、または以下のように `npx allure`)。

```sh
R=.nukadoko/export/allure-results
npx allure watch $R --output .nukadoko/allure-report     # live, re-renders as a run writes
npx allure generate $R --output .nukadoko/allure-report
npx allure open .nukadoko/allure-report                  # serve one already generated
```

生成したレポートの `index.html` は、`file://` では直接開けません。
レポートの SPA は読み込み時に `widgets/*.json` を fetch しますが、`file://` はそれを配信できません。
それでもヘッダとフッタは描画されるため、壊れたレポートが一見すると正常に見えます。
この問題は、CI からレポートの artifact をダウンロードし、手元で `index.html` を開いたときに起きます。
代わりに、上の `npx allure open` または `npx allure watch` でレポートを配信します。

`nuka init` はプロジェクトの root に `allurerc.mjs` を書き出します(Allure が自動検出するいずれかの名前で既にあれば、書かずにその旨を伝えます)。
これを置かないと、nukadoko のあらゆる失敗は Allure 3 に組み込まれた 1 つの category「Product errors」に落ちてしまい、7 個の `error.kind` のどれにも分類されません。
`init` を使わないプロジェクトは、[examples/allure/allurerc.mjs](https://github.com/meganemura/nukadoko/blob/main/examples/allure/allurerc.mjs) を手でコピーして置くこともできます。

各コマンドに `--output` を渡してください。
Allure はこれを省くとカレントディレクトリの `allure-report/` を既定にし、`watch` もそこへ書き込みます。
つまり既定のままでは、レポートを見ただけで、追跡もされず ignore もされていない生成物がリポジトリのルートに残ります。
`.nukadoko/` の下へ出せば、`nuka init` がすでに gitignore に入れた場所に収まります。

反復中は `watch` を使います。
片方の端末で動かしたまま、もう片方で `nuka run` を実行します。
一時的な scenario snapshot が、完了した step ごとにレポートを更新します。
scenario が終わると、最終 result がライブ表示を置き換えます。
待ち受けるポートはランダムで、`--port` で指定できます。
ブラウザを開くのは `--open` を渡したときだけです。
`nuka init` は `.nukadoko/export/allure-results/` を作るため、最初の `nuka run` より前に `watch` を開始できます。
snapshot の仕組みとライブ視聴中のリトライ表示は [Allure emitter](docs/spec.ja.md#allure-emitter) を参照してください。

`allure-results/` にある完了済みのファイルは書き換えられません。
run のファイルは、その run が最新 `retention.runs` 回(既定 20)より古くなった時点で run と一緒に消えるので、レポートに載るのはその回数ぶんの run です。`nuka clean --export` はディレクトリを一度に空にします。
一時的な `*-progress-result.json` は scenario の終了時と次の run の開始時に削除されます。

## Self-healing, with the deviation on the record

**自己修復、ただし逸脱は記録に残す**

スクリプト化された scenario が壊れるのは、アプリが変わったからであり、テストが間違っていたからではありません。
nukadoko が作られているのは、この修復のループのためです。

1. agent は `nuka do` を使い、1 step ずつ各 step record を読んで次の呼び出しを決めながら、目標を適応的に再実行します。
   壊れた scenario をそのまま再生しているのではなく、いま何が通用するのかを見つけ出しているのです。
2. それらの step record は、実際にうまくいった手順を記録します。
   それは定義上、スクリプト化されたものから逸脱しています。
   step record は修復の物語であり、証明ではありません。
   agent は PR の中で、それらをまさにその物語として引用します。
3. PR は型付き step または feature ファイルを更新し、その証明となるのは修復された scenario が green で通ることです。
   すなわち scenario の記録とその step record であり、他のどんな変更とも同じようにレビューされます。

手順 2 が中心です。
**監査証跡のない self-healing では、スイートが気づかないうちに何もテストしなくなります。**
アプリの現在の挙動に合わせて書き換えられた scenario は通りますが、以前の確認が消えたことは誰にも見えません。
ここでは、レビュアーが逸脱の記録を読めます。
証明は常に scenario を通り、ad-hoc な一連の呼び出しを通りません。

nukadoko の貢献は、すべての段階が記録を残すことです。
執筆は agent のワークフロー(この下で扱う、同梱の skill)であり、エンジンの魔法ではありません。
詳しくは [Self-healing, audited](docs/spec.ja.md#self-healing監査付き) を参照してください。

このループは、スイートが空洞化する別の経路を**捕まえられません**。
scenario を保ったまま、その `Then` が弱くなることがあります。
step record は実行が何をしたかを示しますが、assertion がいまも意味を持つかは示せません。
この問題はレビューで捕まえる必要があり、[What this does not do](#what-this-does-not-do) でも説明しています。

## Skills for coding agents

**コーディング agent のための skill**

nukadoko は [Agent Skills specification](https://agentskills.io/specification) に従う 2 つの skill を同梱しており、Claude Code、Copilot、Cursor、Codex、Gemini CLI のどれからでも読み込めます。

- **acceptance** はチケットの受け入れ基準を、コミットされた記録まで運びます(語彙を読み、欠けているものを scaffold し、feature を書き、green になるまで実行し、`nuka accept` します)。
- **migration** は cucumber-js のスイートを 2 段階で移行させ、どの違いがレシピではなく要点なのかを説明します。

```sh
gh skill install meganemura/nukadoko --all   # both, on any Agent Skills host
nuka skill path                              # the copy matching your installed version
```

どちらの skill も、CLI が答えられる内容を書き写しません(語彙、契約、拒否の理由はすべて `nuka steps`、`nuka describe`、stderr から得られます)。
それらを書き写した skill は、コマンドが変わった瞬間から嘘をつき始めるからです。

skill が代わりに運ぶのは、放っておくと agent が自分では思いつかない規律です。
すなわち、修復を 3 回失敗したらそこで止め、さらに推測を重ねる代わりに状況を報告すること。
契約で `mutates` を宣言している step を最初に実行する前には、一度だけ確認を取ること。
書かれた記録を手で編集しないこと、そしてよりきれいな記録を作るために既存の記録を削除しないこと。
そうしなければ、green な実行を最適化する agent は、green への最も安い経路を見つけてしまいます。
そしてその最も安い経路は、たいてい弱い assertion です。

## The compat door

**compat の扉**

ここまでのどれも、既存のスイートがあることを前提にしていません。
この節は、それがある場合のためのものです。

既存の Cucumber + Playwright スイートを移行するには、import を `@cucumber/cucumber` から `nukadoko/compat` に切り替えます。
同じ pattern の構文、hooks、World はそのまま動き、その間に nukadoko の harness が step record の計測を始めます。
その後は各 step を個別に `defineStep` へ昇格できるため、一部だけを昇格したスイートも通り続けます。

扉は入口であり、行き先ではありません。
compat の step は、最初の run から status と時間を持つ step record を得ます。
evidence と `observed` の件数が付くのは、その glue がブラウザや request を `this.openPage()` / `this.openRequest()` で開くようにしてからです([docs/migration.ja.md](docs/migration.ja.md) の measured upgrade)。
ただし、nukadoko は return 値を捨て、step record には `result: null` が入ります。
バリデーション済みの result が必要な機能は使えません。
`nuka check` には feature と比較する契約がなく、`from` は依存関係を宣言できません。
sign-off が確認するのは step の実行だけであり、宣言された契約が保たれたことではありません。
これらの制限が、各 step を昇格させる理由です。

import を元に戻せば、ただの cucumber-js スイートに戻ります。
これは変わらない設計上の規則です(compat の資産は、切り替えにも部分的な移行にも耐えなければなりません)。
その役目は、nukadoko を試すコストを、大きな決断ではなく編集 1 つ分にすることです。
それは戦略を組み立てるための性質ではありません。
`defineStep` に昇格させた step には、切り替えて戻す import がありません: `run` は Playwright 自身のオブジェクトに対して書かれているため body は移りますが、そのスキーマとその上に組まれたものは移らず、ここには元に戻す手段は何もありません(手作業での道筋は docs/migration.ja.md の「戻り道」に書いてあります)。

移行のコストは、推測ではなく計測しました。
監査では、公開されている 8 本の cucumber-js スイートから glue を読み、この扉と比較しましたが、スイートは実行しませんでした。
監査時には、**import の変更だけで通ったものはありませんでした**。
見つかった障害を修正した後、8 本のうち 2 本では拒否される glue がなくなりました。
残る 6 本は、先に短い機械的な準備が必要です。
各障害は import 時または最初の run で失敗し、挙動を黙って変えません。

それらのスイートのうち 3 本は、その後 [nukadoko-lab](https://github.com/meganemura/nukadoko-lab) で、読むのではなく実際に走らせました。
これは固定された corpus を複製し、import を 1 つ書き換え、その結果に対して `nuka run` を実行するものです。
1 本は import だけで通りました。
残る 2 本のうち、1 本はいまは通ります。
step discovery が当初 `.ts` しか読んでいなかったため、素の `.js` で書かれた glue が見つからないままでした。
0.1.0 でその対象が `.ts`/`.mts`/`.js`/`.mjs` に広がり、それ以降 lab が再計測したどの版でもそのスイートは通っています。
もう 1 本はいまも失敗します。
その glue の外にあるファイルが素の `require()` を呼んでおり、discovery はスイートの feature ディレクトリ配下のすべてのファイルを歩くので、step を登録するものだけを見るわけではありません。
そのため import の途中で例外が投げられ、discovery ごと中断します。
`nuka check` はこの失敗を許容してそのファイルを名指ししますが、`run` はフェイルファストで回復しません。
lab を最後に再実行したのは 2026-08-16 です。
glue をテキストとして読むことは、glue の中に見える障害を見つけました。
それを実行することは、見えていなかった障害を 2 つ見つけました。

障害の 1 つは先に名指ししておく価値があります。
それは通過ではなく go/no-go だからです。
**CommonJS のスイートは、この扉をまったく使えません。**
`require("nukadoko/compat")` は、nukadoko が ESM 専用であるため、端的に失敗します。
つまり CommonJS のスイートには、他の何より先にモジュール形式の変更が必要です。
監査した 8 本のうち 2 本は、全体が CommonJS でした。
これはファイル拡張子の話ではなく、モジュール形式の話です。
`.js` や `.mjs` の glue は他と同じように読まれ、`.cjs` のファイルは、後になって何も定義していない step として現れる代わりに、`nuka check` がそれを名指しします。

手順を追ったガイド(監査結果を収録)は [docs/migration.ja.md](docs/migration.ja.md) を、最後まで動く実例は [examples/migration](https://github.com/meganemura/nukadoko/tree/main/examples/migration) を参照してください。

cucumber も Gherkin も無く、Playwright Test だけを使っている場合は別の扉になります。
[docs/migration-playwright-test.ja.md](docs/migration-playwright-test.ja.md) がその道筋です。
スイートはいまの場所に残り、自分の runner を使い続けます。
移るのは操作の実装だけで、spec と typed step の両方がその関数を呼びます。

## Try it against your own suite first

**まず自分のスイートで試す**

何かを移行しなくても、これが合うかどうかは分かります。
agent を自分のリポジトリに向けて、以下のプロンプトを渡してください。
agent は、あなたのスイートの形、移行のコスト、何がうまくいかない可能性があるかを報告します。

<details>
<summary>評価プロンプト(自分のリポジトリで動く agent に貼り付けてください)</summary>

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

**CI で実行する**

`nuka check` と `nuka run` はどちらもスクリプトから呼べます。
すべてが保たれていれば `0` で終了し、問題があれば非ゼロで終了します。
そのため、どちらのコマンドもパイプラインへ普通の 1 step として組み込めます。
以下は抜粋です。
[docs/ci.ja.md](docs/ci.ja.md) には、完全な workflow と、`npx playwright test` から移るプロジェクトが手作業で追加することが多い 4 項目があります。

```yaml
# excerpt from a CI workflow
- run: npx nuka check              # PR gate: static, seconds, no browser
- run: npx nuka run features/      # merge/deploy gate: executes, writes step records
```

`nuka check` はあらゆる PR に置いてください。
安価なゲートであり、何かが実行されるより前に落とせます。
`nuka run` は、実際に真でなければならないゲート、すなわち merge や deploy の側に置いてください。
実行して step record の証跡を残すのはこちらだからです。

`nuka run` は自身の進捗と書き込み先も、走りながら stderr に出力します(`--quiet` は進捗だけを黙らせます)。
stdout はどちらの場合も NDJSON のままです。

**記録を置き換える retry は恒久的にスコープ外であり、「いまはまだ」ではありません。**
green な scenario は、その待ちが正しい場所に置かれている証拠には一切なりません。
scenario が必要としたあらゆる待ちは、もっと下流のどこかに偶然置かれていても供給され得たものであり、それらを一切通らない経路だけが、待ちが本来どこに属するかを示せます([Design](#design) を参照)。
step record の `polls` フィールドは、すでにそれを正直に保っています。
即座に返った 1 回の試行と、20 秒待ち続けた 40 回の試行とを区別します。
step 全体を通るまで再実行し、勝った試行だけを残す retry は、green な実行を買うためにその区別を捨ててしまいます。
ここでスコープ外とされているのはまさにこの形です。
Playwright 自身の `retries` と `testInfo.retry` が取る形であり、最後の試行だけが最終レポートに残ります。
scenario を複数回走らせながら、すべての試行それぞれの記録を残し、どの試行が通ったかを名指しすることは、これとは別の形です。
この形によって、記録が語れない事実を語ることにはなりません。
この形をスコープ外にしているわけではありません。
nukadoko が今日それを行う手段をまだ出荷していないというだけです。
ここに書いているのは、将来の機能が取るべき形についての境界であって、その機能の予告ではありません。

記録を消す形の retry をスコープ外にしても、それが覆い隠していたはずの flake が消えるわけではありません。
サードパーティのスクリプトや CI ランナー上の資源競合は、待ちが正しく置かれている scenario でも失敗させ得ます。
retry が無ければ、その失敗はそのまま run を赤くします。
`nuka run` を merge のゲートに置くスイートには、その失敗を人間がトリアージする必要があります。
直すべきものが常に「待ちの場所が間違っていた」だとは限らないからです。

`nuka run --concurrency <n>` は feature ファイルを並列に実行し、既定の並行度は 1 です。
フル run の壁時計は、並行度を上げるほど短くなり、機に worker をもう 1 つ足す余地が無くなったところで止まります。
どこで止まるかは推測より実測が要ります。10 コアの機では worker 4 個が 8 個に勝ちました。
配る単位は feature ファイル全体なので、1 つのファイルの中の作業は分割できません。
少数の大きなファイルでできたスイートは、同じ scenario が多数のファイルに散っている場合より得が小さくなります。
1 つのスイートを複数の invocation に分けるシャーディングは、record が複数の run id にまたがり、`nuka accept` が 1 つの run として読めなくなるため利用できません。
並列実行によって `nuka run` は速くなりましたが、ブラウザを起動するため、依然としてコストの高いゲートです。
したがって、上で述べた分け方は変わりません。
スイートが大きくなっても PR ゲートを速く保つため、あらゆる PR で `nuka check` を実行し、merge、deploy、夜間の build で `nuka run` を実行します。

`nuka run --repeat <n>` は、選ばれたすべての scenario を 1 回の呼び出しの中で `n` 回実行します。
数回に 1 回だけ再現する失敗のためのものです。
各実行は 1 つの run id の下でそれぞれ自分の record になります。
1 回でも失敗した scenario は、summary の後に `<passed> of <n> passed` の形で集計されます。

## What this does not do

**これがやらないこと**

- **Step record は偽造不可能ではありません。** shell アクセスを持つ agent は、step record を含めどんなファイルでも書けます。これは secrets と同じ、正直な限界です。nukadoko がなくすのは、agent の **説明** を信頼する必要そのものです。実行と計測はツール側にとどまり、それを語る agent 側にはありません。
- **assertion が何かを本当に assert しているかは検査しません。** ある step がその description の主張どおりに正直に動くかどうかは、PR レビューに委ねられます。ツールが保証するのは入出力の形と実行された事実だけです。型付きの契約は、空の assertion をレビューで見つけやすくしますが、それを自動的に拒むものは何もありません。
- **`mutates` は信頼される宣言であり、network が示す内容から導き直されるものではありません。** 書き込みの検出は HTTP メソッドに基づいており、これは書き込みの意味論そのものではなく、そのためのプロキシです。純粋にクライアント側だけの状態や、GET で mutate してしまうサーバは、これでは見えません。一方で、意味的には純粋な読み取りを POST 上に実装している step(GraphQL、RPC-over-POST、多くのベンダーの query エンドポイント)は、一度も行っていない書き込みとしてカウントされてしまいます。この 2 つのケースを一般的な HTTP レイヤーのルールで区別することはできません。だからこそ nukadoko は、その回数で step を失敗させるのをやめました。詳しい議論は [キーワードの意味論](docs/spec.ja.md#キーワードの意味論) を参照してください。その回数はいまも step record と Allure に記録されるため、誤った `mutates` の宣言は事後に反証可能です。判断を担うのは宣言とレビューです。
- **CommonJS のスイートは、先にモジュール形式を変えない限り `nukadoko/compat` を使えません**(上記)。
- **CI レポーティングと HTML のレンダリングは組み込まれていません。** レンダリングを担うのは Allure のダッシュボードです(上記)。CI で何が動き何が動かないか、なかでもリトライだけが計画されていない理由は、[Running this in CI](#running-this-in-ci) で扱っています。

あるチームが、自然言語の層はまったく要らないと結論づけるなら(何を作るか決める人と、チェックを書く人が同じ人たちだというなら)、Playwright Test に直接向かうのは合理的な判断であり、このツールはそれに異を唱えない。
ここでの主張は、その両者が別人であるところから始まり、実装のうちどれだけの部分が、なぜそう書いたのかを尋ねられない何かによって書かれているかに応じて、いっそう強くなる。

## The bed has to be tended

**床には手入れが要る**

nukadoko は、きゅうりを漬ける発酵させた米糠の床です。
それは生きており、毎日手入れをすれば熟成し、放っておけば死にます。
このツールが、あるスイートの step 定義について主張しているのはまさにそれです(書いて終わりの資産ではなく、生きた培養菌だということ)。
そして、これは単に名前についての言い回しにとどまりません。

`nuka check` が問うのは、プロジェクトがいますぐ run できるかであり、あらゆる run の前に読まれることを意図しています。
`nuka tend` が問うのは別の問い、すなわちこれのどこかが腐りつつあるかです。
詳しくは [Tending](docs/spec.ja.md#tending手入れ) を参照してください。
凍結された result が、その step の現在のスキーマをもはや通らない sign-off。
その記録はいまも数えられ続けながら、もはや自分が述べている内容を言い表していません。
何にも行使されない `from` 宣言。
description のないスキーマフィールドは、ファイルを見る人にはそれで問題なく読めても、2 つの step のどちらかを選ぶ agent には何も伝えません。
そのどれも run を止めはしませんが、だからこそどこか他の場所で言われる必要があったのです。
あらゆる run の前に出力されていたら、本当に止めるべき行までみんなが読み飛ばすことを覚えてしまうでしょう。

これは、床がいまどこにあるか(語彙のうちどれだけが、まだ compat のままではなく型付きになっているか)から始まります。
それは、その数がこれまで step record のディレクトリを読むことでしか見えず、そんなことをする者は誰もいなかったからです。

## 誰が何を読むか

コードを書かずに承認する人が PR で開くのは 2 つのファイルです。
`.feature` を開いて、チケットの意図どおりに書かれているかを確かめます。
その隣の sign-off の `.md` を開いて、何がどの commit で走ったかを確かめます。
`.nukadoko/` の下にあるものと `nuka` のすべての動詞は、エージェントか CI のものです。
sign-off record はその最初の読み手のために書かれています。
feature の本文、scenario ごとのサマリ表、そして `mutates: false` と宣言しながら書き込みが計測された step を名指す末尾の節です。
その step の件数は、冒頭の Condition 節に先に書かれています。

## Design

**設計**

設計の全体、すなわち課題設定、型付き step、キーワードの意味論、record、session/environment/secret、sign-off、roadmap、正直な限界は、1 か所にまとまっています: [docs/spec.ja.md](docs/spec.ja.md)。

## License

**ライセンス**

[MIT](LICENSE)
