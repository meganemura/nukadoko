# nukadoko

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
`<feature-basename>.<date>-<sha>.<environment>.<browser>.md`, written beside
the feature. It contains the full feature text, the scenario record, and
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

The door is an entry point, not a destination. A compat step gains evidence
and `observed` counts. However, nukadoko discards its return value, and its
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

## Design

The full design (problem statement, typed steps, keyword semantics,
records, sessions/environments/secrets, sign-off, roadmap, and honest
limits) lives in a single place: [docs/spec.md](docs/spec.md).

Japanese: [README.ja.md](README.ja.md) / [docs/spec.ja.md](docs/spec.ja.md)

## License

[MIT](LICENSE)
