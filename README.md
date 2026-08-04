# nukadoko

> Implementations are generated now. What checks them cannot be. Typed step
> contracts and tool-measured receipts between natural-language acceptance
> criteria and what actually ran.

nukadoko runs Gherkin scenarios under typed step contracts and writes a
receipt for every execution: a record the tool measured rather than the
agent reported. The criteria stay in the language the people who set them
use; everything between those sentences and the system under test is typed,
checked before it runs, and reviewable in a diff.

## Install

Node 20+ (`package.json`'s `engines.node` is `">=20"`).

```sh
npm install -D nukadoko
npx nuka init          # writes nukadoko.config.ts and .nukadoko/ ignores
npx nuka steps         # the vocabulary, empty until you add a step
```

nukadoko is a devDependency: it ships its own TypeScript source alongside
`dist/`, so stack traces land on real code and an agent reading
`node_modules` can see why a thing works, not just its type.

<details>
<summary>No `package.json` yet (Rails, Django, and other non-Node repos)?</summary>

Create one first. Skip `npm init -y`: it copies your existing `README.md`'s
first line into `description` and the directory name into `name`, so it's
more reliable to write the minimum by hand:

```json
{ "private": true, "type": "module" }
```

`"type": "module"` is required, not optional: nukadoko is ESM-only, and
without it every `nuka` command fails with `No "exports" main defined in
.../node_modules/nukadoko/package.json`. That message never mentions
`type`, and nukadoko cannot improve on it, since the CLI hasn't loaded yet
when Node gives up. You don't need to gitignore `.nukadoko/` yourself:
`nuka init` writes that.

</details>

## Wrong before it runs

Gherkin states acceptance criteria as executable scenarios: `Given` /
`When` / `Then` lines in a `.feature` file, with the code behind each line
written separately.

```gherkin
Feature: Projects

  Scenario: A new project appears in the list
    Given a project "acme" exists
    Then the project list includes "acme"
```

The vocabulary behind those lines is not something you go read source to
find. `nuka steps --json` lists it, machine-readable, the same call an
agent's own explore loop starts from. This repository's `examples/todo`
ships a small vocabulary already built; one entry from its output:

```json
{
  "name": "add-todo",
  "kind": "typed",
  "patterns": ["a todo titled {title:string} is added"],
  "description": "Create a todo via POST /todos and return the created record",
  "mutates": true
}
```

Before any of it runs, `nuka check` reads every feature file and every step
file and reports what is wrong. An undefined step is the shallow case: no
step definition matches a line's text, and `check` names the exact line
before a run would ever reach it.

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

These two are a sample, not the list. `nuka check --json` is what answers
"what can this catch": every finding code it knows about, not a count
written here that would drift the next time one is added.

Running one step alone, with no scenario required, shows what actually
lands afterward: not a pass/fail line, a receipt.

```json
{
  "receipt_id": "rcpt-20260804-224640-50lp",
  "step": "add-todo",
  "kind": "do",
  "args": { "title": "Buy milk" },
  "result": { "id": "5c07a3aa-d06a-4421-a708-9d69d8a238e3", "title": "Buy milk", "done": false },
  "status": "ok",
  "observed": { "http_reads": 0, "http_writes": 1 }
}
```

(`evidence`, `environment`, `session`, and the timestamps are trimmed above
for space; the real receipt has them too.)

An existing cucumber-js suite reaches this door too, by switching one
import (see [The compat door](#the-compat-door) below). But a compat step
has no typed contract, so `nuka check` has nothing here to hold a feature
line against, and `nuka do` refuses to run one by name at all.

`check` is the cheap static gate; `run` leaves the receipt trail; `accept`
freezes one green run as a committed record beside its feature; `tend` is
the periodic one, and the only one you are meant to *not* run before every
change.

That accept record is a Markdown file, `<feature-basename>.<date>-<sha>.md`,
written beside the feature: the feature's full text, the scenario record,
and each step's receipt with its evidence stripped.

## Why this exists now

Code is increasingly written the way this sentence was: someone describes
what they want, and a model produces something plausible. That works, and
it changes what "verified" has to mean. When the implementation is
generated probabilistically, calling it correct requires something that was
fixed *before* it was generated and does not move. Otherwise the thing
being checked and the thing doing the checking are drawn from the same
distribution.

Acceptance criteria are already that fixed thing, and they are already
written in natural language, by the people who decide what the software is
for. What has been missing is a way to hold them to their word: a layer
where a sentence someone wrote maps onto an execution that either happened
or did not, with the mapping pinned down hard enough that it cannot quietly
drift into agreeing with whatever got built.

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

An agent must be able to complete the whole loop unassisted: discover the
vocabulary (`nuka steps --json`), read a contract (`nuka describe`, schemas
as JSON Schema), execute one step (`nuka do`, receipt on stdout, meaningful
exit code), read the validated result, and decide the next call. When the
vocabulary lacks an operation, the agent scaffolds and implements a new step
and a human reviews the PR.

That constraint is what produced most of the design. A step has to be
runnable alone, so its dependencies must appear in its signature rather than
on a World, which is also why `this.foo` stops being a place to hide data
flow. A result has to be readable by the next call, so it has to be
validated rather than discarded. An agent's report of a run cannot be the
record of it, so the tool writes the receipt. None of these were built for
agents and then justified for humans; they are the same properties either
way, and a suite that an agent can drive turns out to be a suite a person
can debug.

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

Implemented and covered by tests: typed steps, receipts, sessions,
environments, secrets, `nukadoko/compat`, the Allure and cucumber-messages
emitters, sign-off (`nuka accept`), tending (`nuka tend`), and two agent
skills. Not implemented: an AI-assisted glue converter and scenario
harvesting. See the [roadmap](docs/spec.md#roadmap).

Maintenance is one person working in the open. Every claim below that
carries a number was measured; where something was only reasoned about,
this README says so.

## Upgrading

Use `npm install -D nukadoko@latest`. npm writes a caret range on install,
and on a `0.0.x` version a caret pins the patch as well, so `npm update`
alone will never move you off whichever version you first installed. While
this is 0.x, any release can change the public API, so read the
[changelog](CHANGELOG.md) rather than trusting the range to keep you safe.

## Secrets need no manifest

Point `envFiles` at the env files you already have and git classifies them:
one git doesn't track is a secret source (every value it defines is
redacted from logs and receipts), and a tracked one is plain configuration,
left alone. Nothing to declare, nothing to hand-copy into a second file.

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

After (`defineStep`, named capture, zod, receipt-backed):

```ts
// features/steps/create-project.ts
import { defineStep } from "nukadoko";
import { z } from "zod";

export default defineStep({
  pattern: "a project {name:string} exists",
  description: "Create a project and return its id",
  args: z.object({ name: z.string() }),
  returns: z.object({ id: z.string(), name: z.string() }),
  mutates: true,
  async run(ctx, args) {
    const res = await (await ctx.request()).post("/projects", { data: args });
    return res.json();
  },
});
```

- Named capture (`{name:string}`) binds the value to `args.name` by name.
  With position capture, reordering two same-typed values in the pattern
  silently swaps which one lands where; `nuka check` also flags a bare
  `{string}` as an error before that can happen.
- `args` and `returns` are zod schemas validated at the run boundary.
  `result` in the receipt is something the tool validated, not just
  whatever the step handed back.
- `ctx.request()` above (and `ctx.page()` for browser steps) hand back
  Playwright's own `APIRequestContext` and `Page` objects, not a nukadoko
  wrapper, so existing Playwright knowledge and helpers carry over
  directly.
- `nuka do create-project --args '{"name":"acme"}'` runs this one step
  alone and prints its receipt: the unit an agent's explore loop is built
  on, with nothing to stand up first.

## What it fixes

Each row is a place where the mapping between a sentence and an execution
used to go soft. They are stated against cucumber-js because that is where
they are most familiar, not because it is the only layer that has them.

| The failure | What nukadoko does about it |
|---|---|
| Duplicate steps: which one matched? | `nuka check` reports **duplicate patterns** (the same text registered twice) and **ambiguous steps** (one line in a feature that two different patterns could both match), before anything runs |
| `this.foo`: an untyped bag | A step returns a value against a `returns` schema; a later step declares `from` to read one key of it by name: a dependency that shows up as an import in the diff, a read that lands on the receiving step's receipt, and a binding order `nuka check` verifies before anything runs (see [Chaining steps](docs/spec.md#chaining-steps)) |
| A report that only says `passed` | Every execution writes a receipt: validated result, the network reads and writes the tool itself observed, evidence, environment, target version |
| Undefined steps found at run time | `nuka check <feature>` fails on them statically, and names the text that matched nothing |
| A `Then` that quietly mutates state | `mutates` is a declaration nukadoko trusts, not a number it re-derives: a step declaring `mutates: true` is refused before it runs in a read-only environment and flagged by `nuka check` when bound to `Then`; what actually ran is still recorded on the receipt for review |

The last one is worth being precise about, because the tool used to fail on
the count instead of the promise, and that overclaimed. Write detection
runs on HTTP method, a proxy that breaks for GraphQL, RPC-over-POST, and
any vendor query API that implements a pure read over POST. A truthful
`mutates: false` step calling one of those would still get counted as a
write, for reasons no general HTTP-layer rule can tell apart from a real
one. So nukadoko trusts the declaration instead: it still counts every
non-GET call an execution actually made, through its own request context
and page, but that count now sits on the receipt as a record, not a
verdict.

## Reports fill themselves

A classic Cucumber run shows the evidence a team wired up itself: hook
boilerplate for traces and screenshots, written and maintained per project.
[Allure](https://allurereport.org/) is a test-report dashboard; nukadoko
emits results in its format and never renders HTML itself. The emitter
fills the report from every receipt with zero wiring:
validated result, trace, HTTP log, observed reads and writes, environment
and version, including one no report-side effort could ever add, because
classic Cucumber discards step return values: the validated per-step
result.

A cucumber-messages (NDJSON) emitter ships alongside it so a migrating
team's existing formatters and JUnit-based CI keep working: confirmed by
running our own stream through `@cucumber/junit-xml-formatter`, not just
asserted. See [Allure emitter](docs/spec.md#allure-emitter) and
[Messages emitter](docs/spec.md#messages-emitter).

Since nukadoko writes results and never HTML, rendering them is Allure 3's
CLI (`npm i -g allure`, or `npx allure` as below):

```sh
R=.nukadoko/allure-results
npx allure watch $R --output .nukadoko/allure-report     # live, re-renders as a run writes
npx allure generate $R --output .nukadoko/allure-report
npx allure open .nukadoko/allure-report                  # serve one already generated
```

Pass `--output` on every one of them. Allure defaults it to `allure-report/`
in the current directory, and `watch` writes there too, so the default
leaves a generated report sitting in your repository root, untracked and
un-ignored, from nothing more than looking at a report. Sending it under
`.nukadoko/` puts it where `nuka init` already added a gitignore entry.

`watch` is the one to reach for while iterating: leave it running in one
terminal, `nuka run` in another, and the report updates as each scenario
lands. It serves on a random port (`--port` fixes one) and does not open
a browser unless you pass `--open`. `nuka init` creates
`.nukadoko/allure-results/` up front, so `watch` can already be running
before the first `nuka run`.

`allure-results/` is append-only; nukadoko never clears it. A report
therefore accumulates every run until you delete the directory yourself,
which is also how you start a fresh launch.

## Self-healing, with the deviation on the record

A scripted scenario breaks because the app changed, not because the test was
wrong. The repair loop nukadoko is built for:

1. An agent re-runs the goal adaptively through `nuka do`, one step at a
   time, reading each receipt to decide the next call. It is not replaying
   the broken scenario; it is finding out what works now.
2. Those receipts record the sequence that actually worked, which, by
   definition, deviates from the scripted one. They are the narrative of the
   repair, not its proof, and the agent cites them in the PR as exactly
   that.
3. The PR updates the typed steps or the feature file, and its proof is the
   repaired scenario running green: a scenario record and its receipts,
   reviewed like any other change.

The point is step 2. **Self-healing without an audit trail is how a suite
silently stops testing anything**: a scenario quietly rewritten to match
whatever the app now does still passes, and nobody can see that the thing it
used to check is gone. Here the deviation is a record a reviewer reads, and
attestation always flows through the scenario rather than an ad-hoc
sequence.

nukadoko's contribution is that every stage leaves a record. The authoring is
an agent workflow (the bundled skills, below), not engine magic. See
[Self-healing, audited](docs/spec.md#self-healing-audited).

What this loop does **not** catch is the other way a suite goes hollow: a
scenario left intact while its `Then` quietly gets weaker. A receipt records
what the execution did, not whether an assertion still means anything. That
one stays with review, and [What this does not do](#what-this-does-not-do)
says so plainly.

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

The migration path for an existing Cucumber + Playwright suite is switching
one import (`nukadoko/compat` in place of `@cucumber/cucumber`), keeping
the same pattern syntax, hooks, and World working while nukadoko's harness
starts measuring receipts underneath them. Promoting a step to `defineStep`
is then a per-step decision rather than a rewrite, and a suite that is half
promoted keeps passing.

The door is where a suite comes in, not where it settles. A compat step
does gain evidence and the `observed` counts, which is more than it had.
But its return value is discarded, the receipt records `result: null`, and
everything downstream of a validated result stays out of reach: no contract
for `nuka check` to hold a feature against, no `from` to declare a
dependency with, and a sign-off attesting that steps ran rather than that
stated contracts held. Those are the reasons to promote, and promoting is
what the door is for.

Switching the import back returns a plain cucumber-js suite. That is a
standing design rule (compat assets must survive both the switch and a
partial migration), and its job is to make trying nukadoko cost one edit
instead of a commitment. It is not a property to build a strategy around.
A step promoted to `defineStep` has no import to switch back: its body
still moves, since `run` is written against Playwright's own objects, but
its schemas and everything built on them do not, and nothing here converts
one back (docs/migration.md "The way back" covers doing it by hand).

How much else has to change was measured rather than assumed: eight public
cucumber-js suites had their glue read as text against this door, never
actually run. **None went through on the import alone** when that audit
ran; closing the blockers it found has since brought two of the eight to
where nothing in their glue is rejected. The other six still need a short
mechanical pass first, and every blocker fails loudly at the import or the
first run rather than quietly changing what the suite does.

One blocker deserves naming up front, because it is a go/no-go rather than
a pass: **a CommonJS suite cannot use the door at all.**
`require("nukadoko/compat")` fails outright (nukadoko is ESM-only), so a
CommonJS suite needs a module-format change before anything else. Two of
the eight audited suites were CommonJS throughout.

See [docs/migration.md](docs/migration.md) for the step-by-step guide with
the audit's findings, and
[examples/migration](https://github.com/meganemura/nukadoko/tree/main/examples/migration)
for a worked example running end to end.

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

1. Current state — what test suite exists today: scope, coverage, what
   executes it.
2. Fit — how typed steps + receipts would change the way an agent runs
   this suite's checks: which flows become vocabulary, and what the
   explore-execute-decide loop looks like concretely here.
3. First three migration moves — the first commands to run and the first
   slice of steps to bind (e.g. `nuka init`, binding an initial slice of
   steps, promoting the hottest existing step to a typed one).
4. Risks and costs — an estimate of vocabulary size (how many distinct
   typed steps this suite would need), how much of the existing `Then`
   usage is hygienic (assertion only, nothing chained that mutates) versus
   not, whether the suite is CommonJS, and where secrets currently live
   relative to where nukadoko expects them.
5. Verdict — adopt / trial / not-yet, with the reasoning.

Do not guess at nukadoko internals beyond what its README and docs/spec.md
state. If something is unclear, not yet implemented, or you don't have
access to a document you need, say so rather than assuming.
```

</details>

## Running this in CI

`nuka check` and `nuka run` are both scriptable: each exits `0` when
everything holds and non-zero the moment something is wrong, so either
slots into a pipeline as an ordinary step.

```yaml
# excerpt from a CI workflow
- run: npx nuka check              # PR gate: static, seconds, no browser
- run: npx nuka run features/      # merge/deploy gate: executes, writes receipts
```

Put `nuka check` on every PR: it is the cheap gate, and it can fail before
anything runs. Put `nuka run` on the gate that actually has to be true,
merge or deploy, since that is the one that executes and leaves a receipt
trail behind.

**Retries are out of scope permanently, not "not yet".** A green scenario
is no evidence that its waits are placed correctly: every wait a scenario
needed could have been supplied by coincidence, further down, and only a
route that does not pass through them can show where they actually belong
(see [Design](#design)). A receipt's `polls` field already keeps that
honest, distinguishing one attempt that returned immediately from forty
attempts spent waiting 20 seconds; a retry that reruns a whole step until
it passes throws that distinction away to buy a green run. In a tool whose
receipt is the record of what execution actually happened, "passed on the
third try" is not a fact that record can state.

Parallel execution and sharding are not implemented today. That is a "not
yet", not a permanent limit: both are implementable and under
consideration, unlike retries above.

## What this does not do

- **Receipts are not unforgeable.** An agent with shell access can write
  any file, receipts included: the same honest limit secrets have. What
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
  argument. The count is still recorded, on the receipt and in Allure, so a
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
rotting. A sign-off whose frozen result no longer passes its step's current
schema, so the record is still counted while no longer meaning what it
says. A `from` declaration nothing exercises. A schema field with no
description reads fine to a person looking at the file and tells the agent
choosing between two steps nothing at all. None of those stop a run, which
is exactly why they needed somewhere else to be said: printed before every
run, they would train everyone to skim past the lines that do stop one.

It opens with where the bed is (how much of the vocabulary is typed rather
than still compat), because that number was previously only visible by
reading a directory of receipts, which nobody does.

## Design

The full design (problem statement, typed steps, keyword semantics,
receipts, sessions/environments/secrets, sign-off, roadmap, and honest
limits) lives in a single place: [docs/spec.md](docs/spec.md).

Japanese: [README.ja.md](README.ja.md) / [docs/spec.ja.md](docs/spec.ja.md)

## License

[MIT](LICENSE)
