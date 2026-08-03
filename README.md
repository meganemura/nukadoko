# nukadoko

> Typed step contracts and tool-measured receipts for Cucumber + Playwright
> suites — switch one import to adopt it, switch it back to leave.

If you maintain a cucumber-js suite, you know the failure modes: step
definitions that duplicate until no one knows which one matched, a `this`
that holds whatever the last step put there, and a report that says
`passed` without recording what was actually sent or received. nukadoko
takes on exactly those, and leaves Gherkin's syntax, pattern matching,
review, and the dashboard to the tools that already own them.

Gherkin is the plain-language format Cucumber runs — `Given` / `When` /
`Then` scenarios in `.feature` files, with the code behind each line
("glue") written separately:

```gherkin
Feature: Projects

  Scenario: A new project appears in the list
    Given a project "acme" exists
    Then the project list includes "acme"
```

nukadoko runs those same files. What changes is the code behind them.

## Agent-first is a design constraint, not a slogan

An agent must be able to complete the whole loop unassisted: discover the
vocabulary (`nuka steps --json`), read a contract (`nuka describe`, schemas
as JSON Schema), execute one step (`nuka do`, receipt on stdout, meaningful
exit code), read the validated result, and decide the next call. When the
vocabulary lacks an operation, the agent scaffolds and implements a new step
and a human reviews the PR.

That constraint is what produced most of the design. A step has to be
runnable alone, so its dependencies must appear in its signature rather than
on a World — which is also why `this.foo` stops being a place to hide data
flow. A result has to be readable by the next call, so it has to be
validated rather than discarded. An agent's report of a run cannot be the
record of it, so the tool writes the receipt. None of these were built for
agents and then justified for humans; they are the same properties either
way, and a suite that an agent can drive turns out to be a suite a person
can debug.

Everything prefers machine-readable output. Human prettiness is delegated to
Allure.

## Status

**Pre-0.1, and this is version 0.0.2.** The public API can change without a
major bump until 0.1.

Implemented and covered by 528 tests: typed steps, receipts, sessions,
environments, secrets, `nukadoko/compat`, the Allure and cucumber-messages
emitters, sign-off (`nuka accept`), and two agent skills. Not implemented:
compat gap detection in `nuka check`, an AI-assisted glue converter, and
scenario harvesting — see the [roadmap](docs/spec.md#roadmap).

Maintenance is one person working in the open. Every claim below that
carries a number was measured; where something was only reasoned about,
this README says so.

## Install

```sh
npm install -D nukadoko
npx nuka init          # writes nukadoko.config.ts and .nukadoko/ ignores
npx nuka steps         # the vocabulary, empty until you add a step
```

nukadoko is a devDependency: it ships its own TypeScript source alongside
`dist/`, so stack traces land on real code and an agent reading
`node_modules` can see why a thing works, not just its type.

**Starting from nothing rather than migrating?** Skip the compat door
entirely. Write `defineStep`s directly (see [Before / after](#before--after))
and let the `acceptance` skill carry a ticket's criteria through to a
committed record. Nothing in the typed path assumes a cucumber-js suite came
first — the compat sections below are for suites that already exist.

## What it fixes

| The failure | What nukadoko does about it |
|---|---|
| Duplicate steps — which one matched? | `nuka check` reports **duplicate patterns** (the same text registered twice) and **ambiguous steps** (one line in a feature that two different patterns could both match), before anything runs |
| `this.foo` — an untyped bag | A step returns a value against a `returns` schema; the next step reads it through `ctx.resultOf`, which is an import you can see and a receipt entry you can audit |
| A report that only says `passed` | Every execution writes a receipt: validated result, the network reads and writes the tool itself observed, evidence, environment, target version |
| Undefined steps found at run time | `nuka check <feature>` fails on them statically, and names the text that matched nothing |
| A `Then` that quietly mutates state | `mutates` is a declaration nukadoko trusts, not a number it re-derives — a step declaring `mutates: true` is refused before it runs in a read-only environment and flagged by `nuka check` when bound to `Then`; what actually ran is still recorded on the receipt for review |

The last one is worth being precise about, because the tool used to fail on
the count instead of the promise, and that overclaimed. Write detection
runs on HTTP method, a proxy that breaks for GraphQL, RPC-over-POST, and
any vendor query API that implements a pure read over POST — a truthful
`mutates: false` step calling one of those would still get counted as a
write, for reasons no general HTTP-layer rule can tell apart from a real
one. So nukadoko trusts the declaration instead: it still counts every
non-GET call an execution actually made, through its own request context
and page, but that count now sits on the receipt as a record, not a
verdict.

## Before / after

Promoting a step from regex glue to a typed one. The feature line's text
doesn't change — only the step definition behind it does.

Before (cucumber-js, position capture, untyped, stashed on the World — the
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
- `args` and `returns` are zod schemas validated at the run boundary —
  `result` in the receipt is something the tool validated, not just
  whatever the step handed back.
- `nuka do create-project --args '{"name":"acme"}'` runs this one step
  alone and prints its receipt — the unit an agent's explore loop is built
  on, with nothing to stand up first.

## The compat door, and the way back

The migration path for an existing Cucumber + Playwright suite is switching
one import — `nukadoko/compat` in place of `@cucumber/cucumber` — keeping
the same pattern syntax, hooks, and World working while nukadoko's harness
starts measuring receipts underneath them. Promoting a step to `defineStep`
is then a per-step decision rather than a rewrite, and a suite that is half
promoted keeps passing.

**Switching the import back returns a plain cucumber-js suite.** That is a
standing design rule, not a happy accident: compat assets must survive both
the switch and a partial migration, so leaving is always one edit away.
This is the answer to the fair question of whether to bet an existing suite
on a pre-0.1 tool from one maintainer.

That exit belongs to suites that arrive through compat. A suite written
straight in `defineStep`, with no `@cucumber/cucumber` import ever in the
picture, has nothing to switch back to — starting from nothing carries the
pre-0.1 risk more directly than migrating an existing suite does.

How much else has to change was measured rather than assumed. Against eight
public cucumber-js suites, **none went through on the import alone** when
the audit ran; closing the blockers it found has since brought two of the
eight to where nothing in their glue is rejected. The other six still need
a short mechanical pass first, and every blocker fails loudly at the import
or the first run rather than quietly changing what the suite does.

One blocker deserves naming up front, because it is a go/no-go rather than
a pass: **a CommonJS suite cannot use the door at all.**
`require("nukadoko/compat")` fails outright — nukadoko is ESM-only — so a
CommonJS suite needs a module-format change before anything else. Two of
the eight audited suites were CommonJS throughout.

See [docs/migration.md](docs/migration.md) for the step-by-step guide with
the audit's findings, and
[examples/migration](https://github.com/meganemura/nukadoko/tree/main/examples/migration)
for a worked example running end to end.

## Reports fill themselves

A classic Cucumber run shows the evidence a team wired up itself — hook
boilerplate for traces and screenshots, written and maintained per project.
[Allure](https://allurereport.org/) is a test-report dashboard; nukadoko
emits results in its format and never renders HTML itself. The emitter
fills the report from every receipt with zero wiring:
validated result, trace, HTTP log, observed reads and writes, environment
and version — including one no report-side effort could ever add, because
classic Cucumber discards step return values: the validated per-step
result.

A cucumber-messages (NDJSON) emitter ships alongside it so a migrating
team's existing formatters and JUnit-based CI keep working — confirmed by
running our own stream through `@cucumber/junit-xml-formatter`, not just
asserted. See [Allure emitter](docs/spec.md#allure-emitter) and
[Messages emitter](docs/spec.md#messages-emitter).

## Self-healing, with the deviation on the record

A scripted scenario breaks because the app changed, not because the test was
wrong. The repair loop nukadoko is built for:

1. An agent re-runs the goal adaptively through `nuka do`, one step at a
   time, reading each receipt to decide the next call. It is not replaying
   the broken scenario; it is finding out what works now.
2. Those receipts record the sequence that actually worked — which, by
   definition, deviates from the scripted one. They are the narrative of the
   repair, not its proof, and the agent cites them in the PR as exactly
   that.
3. The PR updates the typed steps or the feature file, and its proof is the
   repaired scenario running green: a scenario record and its receipts,
   reviewed like any other change.

The point is step 2. **Self-healing without an audit trail is how a suite
silently stops testing anything** — a scenario quietly rewritten to match
whatever the app now does still passes, and nobody can see that the thing it
used to check is gone. Here the deviation is a record a reviewer reads, and
attestation always flows through the scenario rather than an ad-hoc
sequence.

nukadoko's contribution is that every stage leaves a record. The authoring is
an agent workflow (the bundled skills, below), not engine magic. See
[Self-healing, audited](docs/spec.md#self-healing-audited).

What this loop does **not** catch is the other way a suite goes hollow: a
scenario left intact while its `Then` quietly gets weaker. A receipt records
what the execution did, not whether an assertion still means anything — that
one stays with review, and [What this does not do](#what-this-does-not-do)
says so plainly.

## Skills for coding agents

nukadoko ships two skills following the
[Agent Skills specification](https://agentskills.io/specification), so
Claude Code, Copilot, Cursor, Codex and Gemini CLI can all load them:

- **acceptance** — takes a ticket's acceptance criteria through to a
  committed record: read the vocabulary, scaffold what's missing, write the
  feature, run it green, `nuka accept` it.
- **migration** — moves a cucumber-js suite across in two stages, and
  explains which differences are the point rather than listing recipes.

```sh
gh skill install meganemura/nukadoko --all   # both, on any Agent Skills host
nuka skill path                              # the copy matching your installed version
```

Neither skill writes down what the CLI can answer — vocabulary, contracts,
refusal reasons all come from `nuka steps`, `nuka describe`, and stderr —
because a skill that copies those starts lying the moment a command
changes.

What they do carry is the discipline an agent won't invent on its own: stop
after three failed repair attempts and report where things stand instead of
guessing further; ask once before the first run of a step whose contract
says it mutates; never hand-edit a written record, and never delete one to
produce a cleaner one. An agent optimizing for a green run will otherwise
find the cheapest path to green, and the cheapest path is usually a weaker
assertion.

## When do you reach for which command

| When | Commands |
|---|---|
| Setting up | `nuka init` → `nuka scaffold <name>` |
| Exploring (the agent's loop) | `nuka steps --json` → `nuka describe <step>` → `nuka do <step> --args '<json>'` |
| Checking before running | `nuka check [feature]` |
| Verifying for real | `nuka run <feature>` |
| Recording an acceptance | `nuka accept <feature>` |
| Keeping posture | `nuka session list` / `clear`, `--env <name>` |
| Handing the loop to an agent | `nuka skill path` |

`check` is the cheap static gate; `run` leaves the receipt trail; `accept`
freezes one green run as a committed record beside its feature.

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

## What this does not do

- **Receipts are not unforgeable.** An agent with shell access can write
  any file, receipts included — the same honest limit secrets have. What
  nukadoko removes is the need to trust an agent's *account* of a run:
  execution and measurement stay with the tool, not with the agent
  describing them.
- **It does not check that an assertion asserts anything.** Whether a step
  truthfully does what its description claims rests on PR review. The tool
  guarantees the shape of inputs and outputs and the fact of execution —
  a typed contract makes an empty assertion easier to spot in review, but
  nothing rejects one automatically.
- **`mutates` is trusted, not re-derived from what the network shows.**
  Write detection runs on HTTP method as a proxy for write semantics, not
  the semantics itself: purely client-side state and a server that mutates
  on GET are invisible to it, and a step calling a semantically pure read
  implemented over POST (GraphQL, RPC-over-POST, many vendors' query
  endpoints) would count as a write it never made. No general HTTP-layer
  rule can tell those two cases apart, which is why nukadoko stopped
  failing steps on the count — see
  [Keyword semantics](docs/spec.md#keyword-semantics) for the fuller
  argument. The count is still recorded, on the receipt and in Allure, so a
  wrong `mutates` declaration is falsifiable after the fact; the
  declaration and review carry the judgment.
- **CommonJS suites cannot use `nukadoko/compat`** without a module-format
  change first (above).
- No test parallelism, sharding, retries, or CI reporting. No HTML
  rendering — that is Allure's job.

## Why not just drop Cucumber?

That is a fair question, and nukadoko is not an answer to it. If a team
concludes the Gherkin layer isn't earning its keep, moving to Playwright
Test directly is a reasonable decision and this tool doesn't argue against
it.

nukadoko is for teams who want to keep Gherkin — usually because
non-engineers read and review the `.feature` files, and that review is the
point — but are paying for it in glue that rots and reports that can't be
trusted. It replaces those two costs while leaving the scenarios, and who
reads them, untouched.

## Design

The full design — problem statement, typed steps, keyword semantics,
receipts, sessions/environments/secrets, sign-off, roadmap, and honest
limits — lives in a single place: [docs/spec.md](docs/spec.md).

Japanese: [README.ja.md](README.ja.md) / [docs/spec.ja.md](docs/spec.ja.md)

## License

[MIT](LICENSE)
