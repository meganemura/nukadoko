# nukadoko

> A living pickling bed for your Gherkin: typed steps, receipts, and an agent-first CLI.

A **nukadoko** (ぬか床) is the fermented rice-bran bed that turns
cucumbers into pickles. It is alive: tended daily it matures, neglected
it dies. That is the claim this tool makes about your Gherkin: feature
files and the typed steps behind them are a living culture, not a
write-once test asset — and tending them, daily, is what an agent is for.

Your `.feature` files are the asset that appreciates in the AI era. Gherkin
is already the largest corpus of executable natural-language specs there
is, and every year agents get better at reading it, running it, and
repairing it — so that corpus is worth more, not less, the longer it lives.
Two things hold it back: glue code that rots invisibly, and reports nobody
can trust. nukadoko takes on exactly those two and leaves the rest —
Gherkin's own syntax, pattern matching, review, the dashboard — to the
tools that already own them well.

That trust question isn't about the scripted scenario run — there, the
tool is already the executor, so there's nothing to distrust. It matters in
the agent's everyday work around that run: the exploratory loop before a
scenario even exists, an agent verifying its own PR, self-healing a
scenario the app broke — and in checking what an agent wrote, not just what
it ran, since a step's execution is measured against its own `mutates`
declaration. nukadoko doesn't call its receipts unforgeable: an agent with
shell access can write any file, receipts included, the same honest limit
secrets have. What it removes is the need to trust the agent's account in
the first place — execution and measurement stay with the tool, not with
the agent describing them.

## Status

**Pre-0.1.** M1 (engine core) and M2 (the compat door) are implemented:
`steps`, `describe`, `do`, `run`, `check`, `init`, `scaffold`, sessions,
environments, secrets, and `nukadoko/compat`. The reporting emitters (M3)
are designed but not built yet — see [Design](#design) for the full
roadmap.

## Evaluate nukadoko against your project

Paste this into an agent working inside your own repository:

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
   not, and where secrets currently live relative to where nukadoko expects
   them.
5. Verdict — adopt / trial / not-yet, with the reasoning.

Do not guess at nukadoko internals beyond what its README and docs/spec.md
state. If something is unclear, not yet implemented, or you don't have
access to a document you need, say so rather than assuming.
```

## When do you reach for which command

Five moments, five commands.

| When | Commands | Why |
|---|---|---|
| Setting up | `nuka init` → `nuka scaffold` | Bootstrap a project; scaffold a step template that fails until implemented. |
| Exploring (the agent's loop) | `nuka steps --json` → `nuka describe` → `nuka do` | Discover the vocabulary, read a contract, execute one step and read its receipt to decide the next call. |
| Checking the vocabulary | `nuka check` | Static checks — pattern/schema mismatches, a mutating step bound to `Then`, undefined steps — before a PR or in CI. |
| Verifying for real | `nuka run` | Execute a scenario; its receipts are the primary evidence trail. |
| Keeping posture | `nuka session list` / `nuka session clear`, `--env <name>` | Carry or clear login state across calls; point a run at a deployment target. |

`check` is the cheap, static gate; `run` is the one that leaves a receipt
trail worth pointing at.

## Before / after

This is true today, not aspirational: promoting a step from regex glue to a
typed one. The feature line's text doesn't change — only the step
definition behind it does.

Before (cucumber-js, position capture, untyped, stashed on the World):

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
- `nuka check` turns a class of glue mistakes — schema mismatches, unnamed
  captures, a mutating step bound to `Then` — into a static error or
  warning instead of something that fails silently at run time, or not at
  all.
- `nuka do create-project --args '{"name":"acme"}'` runs this one step
  alone and prints its receipt — the unit an agent's explore loop is built
  on, with nothing to stand up first.

**M2: a compat door.** The migration path for an existing Cucumber +
Playwright suite is switching one import — `nukadoko/compat` in place of
`@cucumber/cucumber` — keeping the same pattern syntax and World working
while nukadoko's harness starts measuring receipts underneath it: unchanged
code, one line of diff. Promoting a step to `defineStep` is then a per-step
decision instead of a rewrite, and the door swings back — switching the
import again returns to plain cucumber-js. See
[docs/migration.md](docs/migration.md) for the step-by-step guide, and
[examples/migration](examples/migration) for a worked example running end
to end.

**M3 (designed, not implemented): reports fill themselves.** A classic
Cucumber run shows the evidence a team wired up itself — hook boilerplate
for traces and screenshots, written and maintained per project. The
planned Allure emitter fills the report from every receipt with zero
wiring — validated result, trace, HTTP log, observed reads and writes,
environment and version — and one of those no report-side effort could
ever add, because classic Cucumber discards step return values: the
validated per-step result. A cucumber-messages (NDJSON) emitter ships
alongside it so a migrating team's existing formatters and CI reporting
keep working. Neither exists
yet; see [docs/spec.md](docs/spec.md#allure-emitter).

## Design

The full design — problem statement, typed steps, keyword semantics,
receipts, sessions/environments/secrets, sign-off, roadmap, and honest
limits — lives in a single place: [docs/spec.md](docs/spec.md).

## License

[MIT](LICENSE)
