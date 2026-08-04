# nukadoko specification

> nukadoko — a living pickling bed for your Gherkin: typed steps, receipts, and an agent-first CLI.

Status: M1 (engine core) implemented — `steps`/`describe`/`do`/`run`/
`check`/`init`/`scaffold`, sessions, environments, secrets. M2 (compat,
below) is implemented too — `nukadoko/compat`, typed World measurement, and
a migration guide. Both real-world gates have now been run — typed steps
drafted against real feature files, and the compat door audited against
real cucumber-js glue (below). Pre-0.1; of M3+, the Allure emitter and the
messages emitter are both implemented, and so are sign-off (`nuka accept`)
and both of M5's skills. Compat gap detection in `nuka check` — the
migration skill's own prerequisite — is implemented too (see "Compat steps"
and docs/migration.md's "The dashboard is `nuka check`"), closing out
M1-M5.

## What nukadoko is

nukadoko is an agent-first engine that runs Gherkin. Humans write and review the durable
artifacts — feature files, typed step definitions, sign-off records — and
agents execute them. Everything about the runtime is optimized for an agent's
trial-and-error loop: every step has a typed contract, every step can be run
on its own from the CLI, and every execution leaves a receipt the tool
wrote rather than the agent. Not a receipt the agent *cannot* forge — an
agent with shell access can write any file — but one it never had to be
asked to produce (see "Out of scope").

Agent-first is a design constraint, not a slogan. An agent must be able to
complete the whole loop unassisted: discover the vocabulary
(`nuka steps --json`), read a contract (`nuka describe`, schemas as JSON
Schema), execute one step (`nuka do`, receipt on stdout, meaningful exit
code), read the validated result, and decide the next call. When the
vocabulary lacks an operation, the agent scaffolds and implements a new step
and a human reviews the PR. Every interface has a machine-readable form
(`--json`); rich human reporting is delegated to Allure.

One consequence of that constraint deserves stating on its own, because it
directs where this tool grows. End-to-end execution is expensive in a way
unit tests are not: a browser, a real target, minutes. So how much of a
scenario can be judged wrong **without running it** is, in practice, how
fast anyone iterates on it — and for an agent, whose loop is made of cheap
commands, it is directly how fast it can correct its own work. Every
declaration this spec asks for is partly paid for that way: `pattern` and
`args` let `check` reject a line before a browser opens, `mutates` lets it
question a Then, `from` lets it reject a scenario whose steps are in an
order that could only fail. Widening what `nuka check` can settle is
therefore a first-class goal here, not a convenience — and the standing
question after any failed run is whether a check could have caught it
first. The limit is honesty, not ambition: `check` only claims what can
*only* end one way, since a check that guesses trains people to ignore the
ones that don't.

A nukadoko is the fermented rice-bran bed that turns cucumbers into pickles.
It is alive: tended daily it matures, neglected it dies. That is the claim
this tool makes about step definitions — they are a living culture, not a
write-once test asset — and the agent is what tends them.

nukadoko deliberately owns as little as possible:

| Concern | Owner |
|---|---|
| Gherkin syntax (Background, Scenario Outline, tables, docstrings, tags) | `@cucumber/gherkin` — the official parser compiles features into flat "pickles" |
| Step pattern matching (`{string}`, `{int}`, custom parameter types) | `@cucumber/cucumber-expressions` |
| Pretty reports | Allure — nukadoko emits `allure-results`, never renders HTML |
| Approval of what-would-prove-what | git — PR review of features and step definitions, CODEOWNERS |
| **Typed step contracts** | **nukadoko** |
| **Execution and measurement (receipts)** | **nukadoko** |
| **Sessions, environments, secrets** | **nukadoko** |
| **Keyword semantics (Then must not mutate)** | **nukadoko** |
| **Sign-off records** | **nukadoko** |

## Problem

Two independent rots meet here.

**BDD rot.** In Cucumber, step definitions are glue bound by patterns to
prose. The glue library decays invisibly: duplicated steps accumulate,
undefined steps surface only at run time, nothing types what a step consumes
or produces, and the report can only say "passed" — there is no record of
what was actually sent or received. Keywords are decoration: Cucumber
executes a Then exactly like a Given, so nothing stops an assertion step
from mutating state.

**Agent rot.** When an AI agent runs acceptance checks by improvising
browser automation, the agent is both the executor and the reporter of
results. Nothing structurally prevents it from reporting a plausible result
without executing anything, and the improvised operations leave no reviewable
artifact behind.

nukadoko closes both: the vocabulary of operations is committed, typed, and
reviewed; execution is owned by the tool, which measures what happened
instead of trusting anyone's account of it.

## Typed steps

nukadoko follows Cucumber's layout convention: feature files and the code that
supports them live together under `features/`, so a migrating team keeps its
mental model and its directory tree. The suggested home for typed steps is
`features/steps/`, 1 step = 1 file: `features/steps/<name>.ts` (kebab-case;
the file name is the step name).

```ts
import { defineStep } from "nukadoko";
import { z } from "zod";

export default defineStep({
  pattern: "a project {name:string} exists",  // named capture, see below
  description: "Create a project and return its id",
  args: z.object({ name: z.string() }),
  returns: z.object({ id: z.string(), name: z.string() }),
  mutates: true,                               // default true; see keyword semantics
  async run(ctx, args) {
    const res = await (await ctx.request()).post("/projects", { data: args });
    return res.json();
  },
});
```

- `pattern` binds the step to Gherkin text. `patterns: [...]` allows
  aliases; giving both concatenates them, `pattern` first. A step may omit
  patterns entirely — then it is CLI-only
  vocabulary for agents, invisible to feature files but importable by other
  steps: a typed building block, whose `args`/`returns` schemas keep the
  composition checked.
- Every parameter in a pattern is named: `{key:type}` binds that capture to
  the args key `key`. Matching strips the names and hands plain `{type}` to
  `@cucumber/cucumber-expressions` — the syntax owner is unchanged, names
  are a thin layer above it. Names are required (an unnamed `{string}` in a
  pattern is a `nuka check` error) because the alternative — binding
  captures to schema keys by declaration order — swaps two same-typed
  values silently when keys are reordered, and no static check can catch
  that. The binding must survive review by being visible in the pattern
  itself. Aliases must all bind the same key set.
- A pattern's literal text is still cucumber-expressions syntax, not free
  prose: bare `(` `)` mean optional text and bare `/` means alternation, so
  literal occurrences must be escaped — as `\\(`, `\\)`, `\\/` in the
  `pattern` string literal (one backslash in the parsed expression means
  two in TS source) — to match literally. Unlike a schema mismatch, an
  unescaped occurrence still compiles — `nuka check` passes and the step
  registers — and the pattern then silently never matches the pickle text
  it was written for (hit independently in two corpora during validation).
- A parameter cannot appear inside an optional group — an inherited
  cucumber-expressions constraint. The constraint binds the group syntax,
  not the parameter itself: a custom parameter type whose own regexp is
  optional (a `{dir:from-dir}` matching `( from '…')?` or nothing) is
  legal, and is the intended way to fold "the same step with a trailing
  location clause" into one definition — pair it with an `.optional()`
  args key. Without a custom type, each variant needs its own step
  definition.
- Aliases are for prose that is genuinely interchangeable at the args
  level: same keys, same `run()` behavior no matter which phrasing
  matched. If `run()` needs to know which variant matched — behavior forks
  on the phrasing itself — give each variant its own step even when their
  key sets coincide; folding them into one alias would hide that fork from
  reviewers.
- Plurals: a pure suffix plural (`message(s)`) uses cucumber-expressions'
  own optional text `(s)`, no alias needed. When the noun itself changes
  shape rather than just gaining a trailing `s`, use a `patterns` alias
  instead.
- `args` / `returns` are zod schemas, validated at the run boundary (args
  before execution, returns after). A validation failure is a failed run; no
  result is stored. Captures are coerced by the parameter type (`{int}` →
  number, custom types by their transformer), then the schema is the
  contract; the mapping is statically checkable (`nuka check`) in both
  directions. A capture with no schema key is an error. So is a **required**
  schema key that nothing on a given line could fill — no capture, no
  table/docstring, no `from` — because that line can only ever fail args
  validation. The second direction went unchecked for a while, on the
  reasoning that a key might be filled some way the tool could not see;
  `from` closed that gap by making the remaining way visible, so what is
  left is genuinely unfillable rather than merely unexplained.
- A data table or docstring attached to the step binds to the one required
  args key the named captures left unconsumed (tables as `string[][]`,
  docstrings as `string`), validated by the schema like everything else —
  Gherkin tables get types for the first time. Zero or several unconsumed
  required keys with an attachment present is a `check`/`run` error; no
  reserved key name exists.
- `from` declares where an args key's value comes from when the pattern
  did not capture it: `from: { projectId: [createProject, "id"] }` reads as
  "`projectId` is the `id` of whatever `createProject` returned earlier in
  this scenario". The executor fills the key in before args validation, so
  the key stays required and the schema keeps saying what the step actually
  demands. A key name, never a transform, and a key may list several
  mutually exclusive producers — see "Chaining steps" for why that limit is
  the point, for how alternatives are resolved, and for what to do when a
  key name is not enough.
- `mutates` (default `true`): whether the step changes state anywhere it
  touches. Read-only steps declare `mutates: false`.
- `rationale` is optional with no default — omitted, `Step.rationale` is
  `undefined`, the same convention as `pattern`. It answers a different
  question than `description`: `description` is what the step does, the
  information `nuka steps` lists so an agent can pick which step to call;
  `rationale` is why it is implemented this way and what was tried and
  rejected, the information an agent needs before deciding it may rewrite
  the step. It never appears in `nuka steps`' listing — only
  `nuka describe` shows it — and never in a receipt: a receipt records one
  execution, and rationale is a property of the contract that would be
  identical in every receipt for the step, not something that execution
  produced.
- The `run` body is free TypeScript on the provided context. Composition is
  importing another step module and calling its `run` with the same ctx.
  Shared helpers live in ordinary modules (e.g. `features/steps/lib/`).
- Semantic correctness — whether the implementation truthfully performs what
  the description and pattern claim — is guaranteed by PR review, not by the
  tool. Protect `steps/` with CODEOWNERS.

### Context API

`ctx` passed to `run(ctx, args)` carries exactly what the executor must
inject — state the tool owns and the measured chain — and nothing else.
Pure helpers are imports, not context members; that one rule decides
every future "does this belong on ctx?" question.

- `await ctx.page()` — Playwright Page; browser launches on first call,
  restored from the session's storageState, with the configured baseURL
  wired into the browser context so `page.goto("/path")` resolves against
  it.
- `await ctx.request()` — Playwright APIRequestContext with the session's
  cookies. `baseURL` is optional here, the same as `ctx.page()` above: a
  suite that only ever calls absolute URLs across multiple hosts has no
  single baseURL to state, and nukadoko does not force one into config just
  to satisfy this call. If `baseURL` is unset and a step passes a relative
  path anyway, the resulting failure is Playwright's own — nukadoko does
  not re-implement its URL resolution to pre-empt it.
- `ctx.env` — environment variables from the configured envFiles
  (read-only). Not a convenience: it is where determinism (the process
  environment is never merged) and secrets redaction (only values nukadoko
  itself loaded are redactable) are enforced.
- `ctx.requireEnv(name)` — the same value as `ctx.env[name]`, minus the
  presence check every step reading a required variable ended up writing
  for itself; it returns `string`, never `undefined`, by throwing instead
  of returning one. Empty string counts as missing too: an envFile's
  `KEY=` line parses to `""`, not to "key omitted", and a step that
  declared a variable required is exactly as broken either way. The error
  names the key only, never a value — there is no value to show for a
  missing one, and a shape that never carries values cannot become a
  redaction gap later — and it cannot say which envFile to fix, because
  `ctx` only ever sees the merged result, never `config.envFiles`'s list.
  `ctx.env` stays for the rare step that wants every key at once. Every name
  `requireEnv` is called with — whether that call finds a value or throws —
  is recorded on the receipt's `required_env` (see "Receipts"), in read
  order, deduplicated. Reading the same value straight off `ctx.env` leaves
  no trace: that path is a plain object, and the library never sees it.
- `ctx.baseURL` — the configured baseURL, for the occasional URL assembled
  by hand; the common paths get it wired in above. `undefined` when
  `config.baseURL` is unset — legitimate for an absolute-URL-only suite,
  not an error state.
- `ctx.resultOf(stepModule)` — the validated result of that step's most
  recent successful execution in the current scenario; `undefined` under
  `nuka do` or when the step hasn't succeeded yet. This is the scenario
  path's data channel, and it is deliberately not a World: nothing can be
  written to it, only results that passed their `returns` schema can be
  read from it, and the dependency is a visible `import` of the other step
  module — typed by that step's own schema, reviewable in the diff. A
  feature line like "that listing is closed" is implementable exactly to
  the extent its referent produced a validated result. `from` (see
  "Chaining steps") is the declarative form of the same read and the one
  to reach for first; `resultOf` is what remains for the reads a key name
  cannot express. Passing a `Step` that discovery never registered throws
  rather than returning `undefined` — see "Chaining steps" for the mistake
  that rule exists to catch.
- `ctx.section(label: string): void` — marks that execution has reached a
  named stage; synchronous, no return value, no matching "end" call. Every
  call is appended, in call order, to the receipt's `sections` (see
  "Receipts"); a step that never calls it gets no `sections` key at all,
  the same convention `used` follows. It is a bare marker rather than a
  function that wraps a block (`ctx.section(label, fn)`) on purpose: a
  wrapping form would have to decide what nesting, an early `return`, and
  an `await` crossing its boundary mean, and none of that is required to
  answer the question it exists for — where execution stopped, not how
  the block that stopped is shaped.

`page()` and `request()` hand back Playwright's own `Page` and
`APIRequestContext` rather than types of nukadoko's own. That is a choice
with a cost, and it is stated as one (see "Out of scope").

Helpers live as imports: `import { poll } from "nukadoko"` gives the
submit-poll-fetch loop for asynchronous jobs — it needs nothing the
executor owns, so it is not on `ctx`. `ctx.section` looks like it could be
one too, but it isn't: it writes into a collector the executor owns and
resets at each step boundary, the same lifetime `observed` and `used`
already have, so it belongs on `ctx` by this section's own rule. An
earlier version of this boundary rule withheld `ctx.section` entirely, on
the grounds that it would do nothing until a progress-log feature
recorded named stretches of a run live. That reasoning held for a no-op
API and missed where the naming actually needed to land: the receipt was
already the destination, and a step's own execution never needed a live
log to say which stage it reached — only somewhere to write it down.

### Chaining steps

Giving a CLI-only step (one defined without a `pattern`) a `pattern` so it
binds into a scenario raises a question the step never faced standalone: how
does a value an earlier step produced reach this one? Two answers that look
obvious both give something up. Dropping the argument in favor of reading
everything through `ctx.resultOf` loses `nuka do`'s single-step execution —
there is nothing left to pass on the command line — and running standalone
is exactly what makes the vocabulary useful to an agent in the first place,
so that loss is real, not incidental. Folding the whole setup into one
composite step avoids touching the existing steps, but flattens the Given
line: whatever the composite step actually does behind that one sentence
stops being visible to a reviewer reading the feature file.

`from` keeps both by saying, once and as data, where a key comes from:

```ts
import { defineStep } from "nukadoko";
import { z } from "zod";
import createProject from "./create-project.js";

export default defineStep({
  pattern: "the project is archived",
  description: "Archive the project created earlier in this scenario",
  args: z.object({ projectId: z.string() }),
  returns: z.object({ archived: z.boolean() }),
  from: { projectId: [createProject, "id"] },
  async run(ctx, args) {
    // args.projectId is present or this line was never reached.
    const res = await (await ctx.request()).post(`/projects/${args.projectId}/archive`);
    return res.json();
  },
});
```

A pattern capture still wins: `from` supplies only the keys this occurrence
of the step did not capture, so the same step can take the value from the
Gherkin line in one scenario and from an earlier step in another. What it
takes is that earlier step's most recent successful result in this
scenario — the same lifetime `ctx.resultOf` has, because it is the same
chain. Injection happens before args validation, which is the point: the
key stays **required**, and `args` goes on describing what the step
demands instead of describing how one of its callers happens to supply it.

A key may name more than one possible producer. Some values are reachable
two ways — a project a scenario creates, or one it imports — and the
consumer should not have to become two steps to say so:

```ts
from: { projectId: [[createProject, "id"], [importProject, "projectId"]] }
```

What this deliberately does not introduce is a priority. There is no
first-one-wins, no declaration order to remember, no most-recent rule
reaching across different steps. The check below instead requires that
**exactly one** of the listed producers is bound earlier in the scenario:
none is the same error one missing producer already is, and two or more is
an error as well. A scenario whose answer would depend on a rule its own
reader cannot see is one this tool declines to run — which is what makes
this safe to add. The question "which of these supplies the value" gets a
per-occurrence answer from the feature file, not a default from the step.

That is also why this is not settled the way repeats of a *single*
producer are. `Given a project is created` twice, then a consumer, reads
as the latest one, and that holds up: both occurrences carry the same
contract, so the later result supersedes the earlier and the question is
only freshness. Two *different* producers ask which contract the value
came from. Freshness has a defensible default; provenance does not.

Listing producers as alternatives says they are mutually exclusive — one
of these will have run, not both. A scenario that genuinely exercises both
(two paths to the same record, checked against each other) is not that
shape at all, and does not need to be written as one: give each producer
its own key.

```ts
from: {
  createdId:  [createProject, "id"],
  importedId: [importProject, "id"],
}
```

Both are bound, both are read, nothing competes. If a value can arrive
from two producers *in the same scenario* and only one key is waiting for
it, the consumer's own shape is what is wrong — it is asking for one thing
where the scenario has two.

Why a key name and not a selector function. A name is data: it survives
into `nuka steps --json` and `nuka describe` as "`projectId` ← `createProject.id`",
which is what lets an agent assemble an order it was never told, and it is
what `nuka check` reads to judge a scenario before anything runs. A
function would express more and say less — the tool could report which
step a key came from but never which part of it. A `returns` shaped flat
enough to be addressed by key is a mild cost, and steps read better that
way anyway.

Declaring `from` buys a check that costs nothing to be sure about. For
every occurrence of the step in every scenario, `nuka check` — and `nuka
run`, before it executes that scenario, so forgetting to check is not
punished with a browser session — asks whether each declared key is
captured by that line; if it is not, whether the upstream step appears
earlier in the same pickle (Background included, since a pickle carries
its Background steps). A **required** key with no producer bound
earlier is an error: that run would fail args validation with certainty,
so saying so early invents no false positive. An **optional** key with
none is silent — the schema already said the value may be absent, and
warning about a contract being honored would be noise in the one place
noise is fatal. Two or more of a key's listed producers bound earlier is
an error whether the key is required or optional: a schema gets to say
"this value may be absent", but no schema asked for "either of these two,
and the feature file cannot tell you which". This closes the case that
motivated `from`: a scenario that binds the consumer before the producer
used to be indistinguishable from a correct one until minutes of real
browser time had been spent.

`from` and `ctx.resultOf` both identify the upstream step by the `Step`
object itself, never by name, so a step reached through `await import()`
resolves to a different instance than the one discovery registered and
matches nothing. That used to be silent — `resultOf` simply kept returning
`undefined` forever. It is not silent now: an unregistered `Step` is an
error where it is found — `from` names one statically, so `nuka check`
reports it and `run`/`do` refuse to execute the step at all, while
`resultOf` can only be caught at the call, where it throws. A registered
step that has not run yet still returns `undefined`; that is a state, not
a mistake.

What `from` cannot express stays with `ctx.resultOf`: a value that needs
reshaping on the way, a read whose necessity is decided at run time, or a
whole result used as one. Reach for `resultOf` for those, and keep the argument optional
with a fallback inside `run` if the step must also run standalone — the
older shape, now the exception rather than the house style.

Under `nuka do` there is no scenario and therefore no chain, so a `from`
key arrives one of two ways: passed in `--args` like any other, or taken
from an earlier execution's receipt with `--use` (see "Single steps"). A
step's contract does not change between the two paths; only where the
value comes from does.

One thing `from` deliberately does not do: run the upstream step for you.
A key whose producer is missing from the scenario is an error to fix in
the feature file, not a step for the tool to insert quietly — a feature
that does not name everything that ran would stop being the record this
whole tool exists to keep. The related pressure is real and has a
different answer: because a chained value has to come from a step, and a
step has to appear in the feature, a scenario can end up with a line that
exists only to move an id (`And the project's billing page is fetched`)
and means nothing to the reader the feature was written for. When an
operation has no value to that reader, it should not be a step at all —
make it an ordinary function under `features/steps/lib/` and call it from
the step that needs it. What is given up is that helper's own receipt; the
HTTP it performs is still counted in `observed`, and `ctx.section` can
still mark where execution went. Granularity of the record against
legibility of the feature is a judgment the step author makes per case,
and this is the axis to make it on.

Chaining is where declaration and measurement meet, and it meets
differently than `mutates` does (see "Keyword semantics"). There, the
measurement is a proxy — HTTP method standing in for write semantics — so
the tool records both and reconciles neither. Here there is no proxy:
which receipt a value came from is exactly known. And because `from`
drives the execution rather than describing it, the declaration and what
happened cannot drift apart, so there is nothing to reconcile in the first
place. `used` on the receipt (see "Receipts") is therefore not a check on
the declaration; it answers the question the declaration cannot — not
which step supplied the value, which was decided when the file was
written, but which *execution* of it did, which is only ever decided at
run time.

### Keyword semantics

Gherkin keywords carry a real fact because `mutates` is a **declaration
nukadoko trusts**, not because the tool re-derives the fact from what ran
and overrides the declaration when they disagree. Real corpora forced the
split that follows: the same sentence legitimately appears in both Action
and Outcome positions, idiomatic suites chain actions after `Then` via
`And`, and a step wrapping an arbitrary command has no single truthful
`mutates` value. A per-step boolean cannot carry a per-occurrence fact, so
what a declaration settles is layered:

- `mutates` is the step's **declared intent** (default `true`; read-only
  steps declare `false`).
- **Statically**, `nuka check` warns — not errors — when a declared-
  mutating step is bound in Then position. The tension deserves human
  eyes; the declaration alone cannot settle it, and this check only warns.
- **Read-only environments refuse a declared-mutating step before it
  runs** — the one place the declaration gates execution rather than
  drawing review's attention.
- **At run time**, the receipt records what the execution actually did:
  every network call the tool saw (through `ctx.request()` and the page
  alike), with non-GET/HEAD calls counted as observed writes, next to
  `mutates` (declared). That count settles nothing on its own anymore —
  not Then position, not a read-only environment's own policy. A declared
  `mutates: false` is trusted, whatever `observed` says.
- Gherkin classifies an `And`/`But` step by inheriting the pickle step type
  of the preceding primary keyword (Given/When/Then) — gherkin's own
  pickle-compilation behavior, not a nukadoko choice — so an action chained
  after `Then` is recorded under Then-position observation the same as any
  other step there, not gated by it.
- Why measurement stopped settling this: write detection runs on HTTP
  method — non-GET/HEAD counts as a write — which is a proxy for write
  semantics, not the semantics itself. GraphQL, RPC-over-POST, and most
  vendors' query APIs implement a semantically pure read over POST; whether
  a call actually changed server state is the external system's own
  semantics, and nukadoko sits one layer below that, at HTTP. What would
  distinguish a read from a write is protocol-specific every time — a
  GraphQL body's `query` vs. `mutation`, an RPC body's method name, a
  vendor's own path convention — so no general mechanical judgment can
  stand in for the proxy. What the count guarantees is what a step sent,
  not whether the server's state changed; those are different facts, and
  treating the first as proof of the second overclaimed.
- Nothing about the record shrank: `observed`, http.jsonl, and the Allure
  declared/observed table stay exactly as measured, so a declaration that
  turns out wrong is still visible there — falsifiable after the fact.
  Accepting a falsifiable declaration is not measurement giving up; it is
  where the tool's authority over this particular fact actually ends.
- Falsifiable does not mean checked: nukadoko never runs that reconciliation
  itself, even though `mutates` and `observed` already sit on the same
  receipt so an operator can compare them without a second artifact. No
  `nuka run` or `nuka check` output claims a mismatch between the two.
  Automating that claim would mean trusting the same HTTP-method proxy as
  settled fact — a GraphQL call, an RPC-over-POST call, or a vendor API that
  reads over POST would each read as a false positive, every time — which is
  the same reason run-time enforcement was dropped, above, applied here to
  reporting instead of execution. `nuka accept`'s own record is the one
  place this comparison is written out (see Sign-off) — sign-off is the
  single moment a human already reads and judges a run, so stating the raw
  fact there costs nothing in false-positive noise the way stating it on
  every `nuka run`/`nuka check` invocation would.
- Compat (untyped) steps have no `mutates` to declare at all (see "What
  compat steps lack") — `nuka check`'s `then-compat-step` warning flags
  one bound in Then position as that coverage gap instead of a mutation
  tension, and run-time observation records its counts the same as any
  step's, gating nothing.

## Compat steps (the migration door)

The adoption path for existing Cucumber + Playwright suites is switching an
import:

```ts
// before: import { Given, When, Then } from "@cucumber/cucumber";
import { Given, When, Then } from "nukadoko/compat";
```

- Compat steps run as-is: same pattern syntax, a World (`this`) whose
  `page` / `request` are provided and managed by nukadoko's harness. Custom
  World classes extend nukadoko's base via `setWorldConstructor`. The supported
  API is the commonly used subset (Given/When/Then, World, Before/After,
  AfterStep); it grows on demand, not speculatively.
- Registration semantics: `Given`/`When`/`Then` are three names for one
  registration — a keyword means nothing at registration time; position in
  the scenario decides at run time, exactly as in Cucumber. Patterns are
  strings (plain cucumber-expressions — named captures are not required
  here; that discipline belongs to typed steps) or RegExp, since legacy
  glue is regex-heavy and the door must admit it. Both call shapes
  cucumber-js accepts are accepted — `Given(pattern, fn)` and
  `Given(pattern, { timeout }, fn)`, the timeout honored — and an
  unrecognized option key throws at registration rather than disappearing.
  Discovery imports the
  files and attributes each registration to the file that made it; a
  compat step's identity is its pattern text, `nuka steps` lists it with
  its kind, `nuka describe` shows the contract it doesn't have, and
  `nuka do` refuses it by name — promoting to `defineStep` is what buys
  single-step execution.
- `defineParameterType` from compat code registers into the same single
  registry as `config.parameterTypes` — moving a registration to config
  changes nothing about what any pattern matches, which is what makes the
  move safe to take early. `nuka check` lists support-origin registrations
  as warnings: config is where they retire to.
- Execution keeps the door's promise two ways: glue that launches its own
  Playwright keeps working, unmeasured, while `await this.openPage()` /
  `await this.openRequest()` hand out the harness's measured page and
  request — the same context a mixed scenario's typed steps share,
  cookies and all. Tables arrive as a thin, dependency-free `DataTable`
  (raw/rows/hashes/rowsHash/transpose), because `table.hashes()` glue
  must not break on an import switch; docstrings stay plain strings.
  Before/After hooks may be written any of the three ways cucumber-js
  accepts (`Before(fn)`, `Before({ tags }, fn)`, `Before("@tag", fn)`),
  receive cucumber's own hook parameter, filter on `@tag` / `not @tag`
  only — anything fancier fails loudly rather than mismatching silently —
  appear in the scenario record's `hooks` array rather than as receipts,
  and their network traffic sits outside any step's boundary. `AfterStep`
  shares that same registration surface (all three call shapes, the same
  `@tag` / `not @tag` filter), but where Before/After bracket the whole
  scenario, it runs once per pickle step that actually executed. A step
  this scenario skipped because an earlier one already failed never began,
  so there is no "after" for `AfterStep` to run at, and none appears for
  it — the same convention a tag-mismatched hook already follows. Each
  `AfterStep` entry in the `hooks` array carries `step_index`, the executed
  step's 0-based index into that record's own `steps` array, so a report
  can tell one entry from another; both the Allure and cucumber-messages
  emitters carry it through. The hook parameter's `result.status` reuses
  `@cucumber/messages`'s own `TestStepResultStatus` string values, and
  `nukadoko/compat` re-exports that same enum as `Status`, so glue written
  as `result.status === Status.FAILED` now imports and compares correctly.
  The enum's other members — `PENDING`/`SKIPPED`/`UNDEFINED`/`AMBIGUOUS` —
  can never match, because nukadoko has no pending, skipped, undefined-step,
  or ambiguous-match concept for a hook's own result to carry; a comparison
  against one of those is a branch migrated glue simply never takes, not a
  gap left open.
  `BeforeAll`/`AfterAll` bracket the whole run instead of a scenario — no
  tags, no World, skipped entirely when no scenario was selected — and
  report through the exit code, since a record is a scenario-shaped thing
  and these belong to no scenario. `setDefaultTimeout` supplies the default
  for anything that didn't declare its own; leaving it uncalled keeps steps
  unbounded rather than importing cucumber's five-second ceiling, which
  would fail slow suites for no reason but migrating.
- The World is measured, always: every compat step's receipt records
  which World keys it read and wrote, in access order — the data flow
  `this.foo` used to hide. The measured surface is the bag's own data
  properties; `#private` state never appears there, by construction — a
  named boundary, not a bug. `defineWorld({ key: zodSchema })` opts
  individual keys into validation (a write that fails its schema fails
  the step and is never recorded as a write) and types `this` via
  `class MyWorld extends defineWorld({...})`. Cucumber's own
  `attach`/`log`/`link`/`parameters` are reserved: never measured, never
  declarable, and clobbering one is an error instead of a silent break.
- Because the harness owns the browser and request objects, compat steps
  already get measured receipts — status, timing, trace, screenshots, HTTP
  log — with zero code change.
- What compat steps lack: typed contracts, a validated `result` in the
  receipt, and single-step CLI execution. Promoting a hot step to
  `defineStep` is the upgrade, one step at a time.
- The door's width is measured, not asserted. Eight public cucumber-js
  suites were audited against it — their glue read as text, never run — and
  none of them ran on the import switch alone at the time, and closing the
  blockers it found has since brought two of the eight to where nothing in
  their glue is rejected; what the rest still need is enumerated in
  [docs/migration.md](migration.md). The rule that follows,
  and that the audit's findings were spent on: whatever compat does not
  support must fail at the import or on the first run, never quietly. A
  migrating team can act on a loud failure and cannot see a silent one, so
  a gap that changes behavior without saying so costs more trust than the
  missing feature ever cost time.
- Loud failure splits into what a static pass can already say and what only
  running a step reveals, and `nuka check` reports exactly the first half.
  **`nuka check` can say it**: a step file whose import throws — a name
  `nukadoko/compat` doesn't export, used as a value; a CommonJS `require` in
  ESM glue; a deep subpath import — becomes a `step-file-import-failed`
  error, and a hook's tag expression beyond a single `@tag` / `not @tag`
  becomes `unsupported-hook-tag-expression`; both are known from the file's
  own text, before anything executes. **Only `nuka run` finds it**: a step
  or hook returning `"pending"` / `"skipped"`, and done-callback glue —
  these are properties of what happens when that step actually runs, not of
  how its file imports, so nothing before the step's own execution can name
  the fault. **Neither is a gap**: a name imported but used only as a type
  annotation, or imported and never referenced, is elided from the compiled
  output by esbuild before nukadoko ever imports the file, so that import
  never actually happens at run time — the glue runs exactly as written.
  `tsc` still resolves the name against what compat exports, so a missing
  one is a compile error rather than a run-time one. That is exactly why
  the two names the audit found in this category, `IWorldOptions` and
  `ITestCaseHookParameter`, were worth exporting even though `nuka` never
  saw them fail: what they cost was the user's typecheck, not their run.
- Standing design rule, for this section and every future design that
  touches migration: a compat asset that works today must not stop working
  because the team adopted nukadoko or moved some other piece toward the
  typed side. Transitional two-home states (a parameter type registered in
  support code while another lives in config; a World bag alongside typed
  results) are accepted rather than forbidden — but they must share one
  underlying mechanism, the split must be surfaced by `nuka check` instead
  of hidden, and every individual migration move must be
  semantics-preserving so it can be taken early and safely. The door
  swings both ways: switching the import back must remain possible.
- A step-by-step walkthrough of this door for an existing cucumber-js +
  Playwright suite lives in [docs/migration.md](migration.md).

## Running

### Scenarios (the scripted path)

```sh
nuka run features/checkout.feature[:12] [--env <name>] [--session <name>]
```

`@cucumber/gherkin` compiles the file into pickles — flat, self-contained
scenarios with Background merged, Scenario Outline expanded, and tables
attached. nukadoko matches each pickle step against the committed patterns and
executes the steps in order. One receipt per step; one scenario record
(feature path, scenario name, ordered receipt ids, per-step status) per
pickle.

Steps in one pickle share one context — the World semantics Cucumber users
expect: a Background that logs in hands its browser and cookies to every
later step. A failed step skips the rest of the scenario, and skipped steps
get no receipt (an execution that never began must not be citable; the
scenario record is what says "skipped"). Evidence follows its natural
scope: each step's receipt carries that step's http.jsonl, while the
Playwright trace spans the shared context and therefore lives in the
scenario's own directory, not on any single step.

Before a pickle runs, its steps' `from` declarations are checked against
its own step order: a required chained key whose producer is absent or
bound later fails that scenario before anything launches, since executing
it could only end in the same failure minutes later (see "Chaining
steps"). Other scenarios in the file still run — this is one scenario's
property, not the file's.

An undefined step fails the scenario naming the text that failed to match
and suggests `nuka scaffold`. An agent following the bundled skill authors
the missing typed step and submits it as a PR — the feature backlog drives
vocabulary growth.

### Single steps (the agent path)

```sh
nuka do create-project --args '{"name":"acme"}' [--env <name>] [--session <name>]
nuka do archive-project --use rcpt-20260801-143022-a1b2
```

Executes one typed step and prints its receipt to stdout (exit 0 on ok, 1 on
failed). This is the adaptive loop: the agent reads the validated result and
decides the next call. The agent can only choose which step to call with
which args; it cannot choose what gets recorded. There is deliberately no
grouping label on `do`: ad-hoc sequences are working records, not evidence —
anything worth attesting to is expressed as a scenario and proven by
`nuka run` (see Self-healing).

`--use <receipt-id>` (repeatable) supplies the step's `from` keys from an
earlier execution instead of the chain a scenario would have provided (see
"Chaining steps"). The upstream step's name is not written on the command
line because the receipt already carries it: nukadoko reads which step that
receipt records, finds the `from` entries pointing at it, and takes the
named keys out of its stored `result`. A receipt for a step this one does
not declare a `from` on is an error rather than a silent no-op, as is a
receipt whose execution failed — a failed step never produced a validated
result to read. `--args` still wins over `--use` for the same key, the same
way a pattern capture wins inside a scenario. The receipt ids actually
drawn from land in this execution's own `used`, so a chain assembled by
hand across several `do` calls is as traceable afterwards as one a scenario
drove.

## Receipts

A receipt is the tool's own measurement of one step execution — the same
shape whether the step ran inside a scenario or via `do`.

```json
{
  "receipt_id": "rcpt-20260801-143022-a1b2",
  "step": "create-project",
  "kind": "do",
  "args": { "name": "acme" },
  "result": { "id": "p_0001", "name": "acme" },
  "status": "ok",
  "mutates": true,
  "observed": { "http_reads": 2, "http_writes": 1 },
  "environment": "dev",
  "target_version": "1.4.2+abc123",
  "session": "checkout-flow",
  "scenario": null,
  "started_at": "...",
  "finished_at": "...",
  "evidence": {
    "dir": ".nukadoko/receipts/rcpt-20260801-143022-a1b2",
    "trace": "trace.zip",
    "screenshots": ["final.png"],
    "http": "http.jsonl"
  }
}
```

- `result` is the trust anchor: it passed the returns schema and the tool —
  not the caller — produced it. On failure, `error: { kind, message }`
  replaces it. Compat steps record `result: null`.
- `error.kind` is a closed set, beside the message a human reads:
  `args_invalid`, `result_invalid`, `binding_invalid`, `world_invalid`,
  `timeout`, `unsupported`, `step_error`. Closed because a report has to
  classify against it — an open one, extended per step, would classify
  nothing. The first four name failures that exist only because there is a
  contract to violate, which is the part a report built on a runner that
  discards return values cannot fill in; a classifier that isn't sure says
  `step_error`, since claiming a contract failure wrongly is worse than not
  claiming one. Hook records in the scenario record carry the same field.
- `mutates` is the step's own declaration (`null` for a compat step, which
  has none to record — not `false`), sitting beside the `observed` counts
  so declared and measured can be compared without a second artifact.
- Evidence is collected by the harness, never reported by the step: Playwright
  tracing and screenshots when the browser is used, every `ctx.request()`
  call logged to http.jsonl, the receipt itself as the primary record.
- `observed` counts the network calls the tool itself saw the execution
  make, through `ctx.request()` and the page alike; non-GET/HEAD counts as
  a write — HTTP method as a proxy for write semantics, not semantics
  itself, so a POST-based read counts against a step that never wrote
  anything (see Keyword semantics). It settles nothing on its own: Then
  position and read-only environments act on the `mutates` declaration,
  never on this count. `observed` sits beside `mutates` (declared) so a
  wrong declaration is falsifiable, here and in the Allure report.
- `used` (present only when non-empty) lists the earlier executions whose
  results this one drew a value from — through a `from` injection, a
  `ctx.resultOf` call, or a `--use` receipt on `nuka do`. Every path runs
  through library code, so the reads are measured, not declared. Each entry
  is `{ "receipt": "rcpt-…", "step": "create-project" }`: the step name is
  redundant with the cited receipt and is written down anyway, because a
  receipt that has to be resolved against other files to be read is a worse
  acceptance record than one that is legible alone — and the file it would
  be resolved against is a local working record that a sign-off (see
  Sign-off) long outlives. Entries are deduplicated by receipt id, in the
  order first read. The dependency is thus visible twice over: statically
  as `from` or an import, at run time as provenance in the receipt chain.
  Which upstream *step* a value came from was settled when the step file
  was written; which *execution* of it supplied the value is knowable only
  here.
- `sections` (present only when non-empty) lists the labels `ctx.section`
  was called with, in call order. Not deduplicated, unlike `used`: a label
  entered twice — a loop, a retry — was entered twice, and the array
  should read that way, where `used` names a receipt id once because an id
  is an identity worth citing once, not a point in a sequence. It carries
  no timing: the question is where execution stopped, not where it was
  slow, and `string[]` can widen to a richer shape later without a
  breaking change, while building that shape now would ship parts nobody
  asked for. A failed step's `sections` still holds whichever labels it
  reached before the failure, and that array's last element already
  answers "which stage was it in" — there is no separate `error.section`
  field putting the same fact in a second place. Only a typed step's `ctx`
  has `section`; a compat step has no counterpart on `this`, so `sections`
  is simply omitted for one, the same way `used` is omitted for a typed
  step that never read from the chain.
- `required_env` (present only when non-empty) lists the names
  `ctx.requireEnv` was called with during this execution, deduplicated, in
  the order first read — the same measured-not-declared shape `used` and
  `sections` already have, since `requireEnv` is the one call site the
  library controls. Recorded before a missing key throws, so a
  `MissingEnvError` failure's receipt still shows what the step asked for.
  Only names are recorded, never values — a value can be a secret. A step
  that reads `ctx.env[name]` directly leaves no trace here: this field
  counts only what passed through `requireEnv`, never a plain object read
  the library never sees.
- Receipts live under the state directory (`.nukadoko/`, gitignored). They are
  local working records; the durable artifacts are sign-offs.

## Sessions, environments, secrets

The execution infrastructure Cucumber never had:

- **Sessions** carry login state across CLI calls as Playwright storageState,
  stored per environment, advisory-locked to one run at a time. No `--session`
  means a clean start; there is no implicit shared state. No daemon.
- **Environments** name deployment targets: per-environment `baseURL`,
  `envFiles`, `policy: "read-only"` (refuses mutating steps), and an optional
  `version` probe recorded on every receipt as `target_version`. A sign-off
  freezes both, so a record names the deployment it was green against.
- **Secrets**: git is the classifier for *origin* — an env file git does
  not track (ignored or untracked, never distinguished) is a secret
  source: every value it defines is a secret, no declaration needed.
  Tracked env files are plain configuration (a committed value is not a
  secret, and nukadoko will not pretend otherwise). Outside a git
  repository every envFile is treated as a secret source. Origin and
  *handling* are two different questions, though: `secrets.public`
  demotes an individual secret-source key to plain, never redacted;
  `secrets.redact` does the opposite, naming an individual tracked-file
  key to redact anyway. `redact` does not dispute git's own origin
  classification, and it is not a claim that a key "is a secret" the way
  membership in a secret-source file is — it is an instruction not to let
  that key's value spread to a *new* surface (a terminal, a CI log, a bug
  report someone pastes, an agent's own conversation transcript) just
  because the repository already has it. Both origins share one token,
  `{{secret.NAME}}` — there is no second `{{redacted.NAME}}` marker, so a
  receipt reader only ever has to recognize one redaction shape. The same
  key cannot be named in both `public` and `redact`: that is a config
  error, since the two lists give opposite instructions for one key.
  Secret values, from either origin, are redacted wherever a receipt is
  emitted — receipt.json, `do`'s stdout copy, http.jsonl — applied by the
  executor at write time, never controllable from a step's `run`. Honest
  limits: values shorter than 4 characters are never redacted (this floor
  applies to a `redact`-named value exactly as it does to any other
  secret), only values nukadoko itself loaded are redactable — a fresh
  token inside a step's result is not caught — and a tracked value not
  named in `secrets.redact` still reaches every one of those surfaces in
  plaintext, including an agent's own conversation log: that log did not
  exist when `.gitignore`'s tracked/untracked line was drawn, so "already
  in the repository" was never a judgment about it. Traces and
  screenshots are not redacted; the state directory is sensitive. `nuka
  check` reports each env file's classification and secret-key names
  (never values), plus three warnings: `secrets.public`/`secrets.redact`
  naming a key no configured envFile defines, `secrets.redact` naming a
  key whose value is too short to ever actually be redacted, and — for a
  tracked env file only — a key whose *name* looks like it holds a secret
  (`SECRET`, `PASSWORD`, `TOKEN`, `CREDENTIAL`, or a `KEY` suffix) but
  isn't named in `secrets.redact`. That last check is a name-pattern
  heuristic, and it is used for exactly one thing: deciding whether to
  print the warning. It never decides redaction — a name "looking like" a
  secret does not add it to what gets redacted; only git's tracked/
  untracked classification and `secrets.redact` do that.

Configuration lives in `nukadoko.config.ts` (`defineConfig`): `featuresDir`
(default `features`; feature files and step code both live under it,
Cucumber-style), `baseURL`, `envFiles`, `environments`,
`stateDir` (default `.nukadoko`), `browser`, `browserContext`,
`requestContext`, `secrets`, `parameterTypes`, `allure` (only `resultsDir`,
see "Allure emitter"), `messages` (only `output`, see "Messages emitter").

`browser` takes Playwright's own `LaunchOptions` type directly (chromium is
the only browser type; `newContext`'s options like `viewport` are a
different Playwright type and are not accepted through this key — see
`browserContext`/`requestContext` below). zod does not re-validate its shape
beyond "is this an object": the type comes from `defineConfig`, so `tsc`
catches a typo the same way it catches one anywhere else in
`nukadoko.config.ts`; re-enumerating Playwright's options in zod would need
updating every time Playwright adds one, and a config author would be
blocked from a real option until that catch-up landed. Only `headless` is
read today, passed straight to `chromium.launch`; omitted, Playwright's own
default (`headless: true`) applies.

`browserContext` and `requestContext` are `newContext`'s counterpart to
`browser`'s `launch`: `browser.newContext()` (used by `ctx.page()`) and
`playwrightRequest.newContext()` (used by `ctx.request()`) are two separate
Playwright calls with two separate option types, so each gets its own
config key rather than one shared key, the same "defer to Playwright's own
type" policy `browser` follows. This is what makes an option like
`ignoreHTTPSErrors` reachable at all — for a self-signed-certificate local
target, neither `ctx.page()` nor `ctx.request()` previously had a way to
set it. Both keys reject `baseURL` and `storageState` with an error naming
the reason, rather than silently dropping them: `config.baseURL` is meant
to be the one source of a project's base URL, and nukadoko's own session
mechanism sets `storageState`, so accepting either again here would let
config quietly disagree with itself about which value is real.

A `parameterTypes` entry registers a custom cucumber-expressions parameter
type — `{ name, regexp, transformer? }`, e.g.
`{ name: "negation", regexp: /( not)?/, transformer: (s) => s === " not" }`
lets a pattern bind `will{negated:negation} return` to a plain
`z.boolean()` args key. Registration lives in config because config is
already executable TypeScript (the same reason the version probe is a
function); nukadoko has no support-file format to put it in. Names must
not collide with the built-in types — redefining what `{int}` means per
project would quietly change the meaning of every pattern that uses it.
The transformer is coercion; the args schema remains the contract.

An environment entry is `{ baseURL?, envFiles?, policy?: "read-only",
version?: () => string | Promise<string> }`. Its `baseURL` overrides the
top-level one; its `envFiles` append after the top-level list (later files
win — the common-plus-override layering dotenv users already know);
`policy` and `version` exist only per environment. No `--env` means the
name `default`, which needs no entry; an explicitly named environment must
exist — naming one asserts it does. The `version` probe is a function
because config is executable TypeScript already (a URL+jsonPath DSL would
be a worse way to write `fetch`); the tool calls it once per run with a
10-second budget, and a throw or timeout costs only `target_version`,
never the run.

### The state directory

Everything nukadoko writes at run time lives under `.nukadoko/` (gitignored by
`init`); none of it is meant to be committed:

- `receipts/<id>/` — one directory per receipt: the receipt JSON and its
  evidence files (trace.zip, screenshots, http.jsonl)
- `scenarios/<id>/` — one directory per scenario run: `record.json` plus
  the scenario-scoped evidence (trace.zip, final screenshot) — mirroring
  Playwright's own per-test `test-results/` convention one level up
- `sessions/<env>/<name>.json` — storageState; live credentials in
  plaintext, created with restricted permissions
- `allure-results/` — the emitter's output, appended to across runs and
  safe to delete whenever a fresh Allure launch is wanted; `init` also
  creates it empty, since Allure's own CLI refuses to start against a
  missing directory but accepts an empty one, letting `allure watch` already
  be running before the first `nuka run`
- `messages.ndjson` — the messages emitter's output, one stream per run;
  truncated at the start of every `nuka run` (see "Messages emitter")

The durable artifacts live in the repository instead: feature files, typed
steps, and sign-off records.

## Sign-off

A sign-off records that an agreed scenario ran green at a named commit. It
exists for acceptance — confirming once that a ticket's criteria are met —
not for regression. The scenario is written from the ticket's acceptance
criteria, run until it is green, and then kept as a record; re-running it
later is not the point, and nothing in nukadoko re-runs it.

```sh
nuka run acceptance/PROJ-123.feature     # execute, as often as needed
nuka accept acceptance/PROJ-123.feature  # freeze the last green run
```

- `accept` does not execute. Signing off is an explicit act, not a side
  effect of a green run — "keep accepting until it passes" is not a
  meaningful loop. It takes the newest green run of that feature and
  freezes it. Runs are identified by feature path, never by id: run ids
  exist for machines reading `nuka run`'s output, not for humans to type.
- It refuses unless the working tree is completely clean, untracked files
  included, and the run it is freezing happened at the current HEAD. The
  record's whole claim is "this scenario was green at commit X"; an
  untracked step file the discovery would have loaded, or a commit made
  between the run and the sign-off, makes that claim false. The scenario
  record grows one field to make this checkable: the commit the working
  tree was at when the run started.
- A red run produces nothing. There is no verdict field and no record of
  failure: a scenario that did not pass gets fixed and re-run, and what is
  worth keeping is the outcome, not the attempts.
- The record is written beside the feature it came from, named
  `<feature-basename>.<date>-<sha>.md`. nukadoko does not choose a
  directory — where acceptance work lives is the project's decision. A
  project that wants these out of its regression suite puts the feature
  outside `featuresDir`, and the record follows it there.
- It carries the feature's full text, the scenario record, and each step's
  receipt with evidence stripped — traces and screenshots stay in
  `.nukadoko/`, and a CI artifact is where they belong when they are
  wanted at all. The copy is made by the tool, never transcribed by a
  human: transcription would demote a measurement back to a claim.
- The record's own tail carries one more section, "Declared vs observed":
  every step across every scenario in the record whose receipt declared
  `mutates: false` but was measured making at least one write
  (`observed.http_writes > 0`, see Keyword semantics), stated as a raw
  fact — declared value beside the observed count — never a verdict. It
  never refuses: none of the refusal conditions above read it, and a step
  that reads over POST is expected to land here every time it is accepted,
  by design (the same HTTP-method proxy that made run-time `mutates`
  enforcement itself unreliable, above). Rolled into one section covering
  every scenario, not spread one line per scenario, so it cannot be
  scanned past by accident. Written even when nothing disagrees, so
  "compared, found nothing" stays distinguishable from "never compared at
  all". A compat step (`mutates: null`, see "What compat steps lack") has
  no declaration to compare against `observed` at all; it is counted
  separately, never folded into either outcome above, since "nothing to
  compare" and "compared and matched" are different facts.
- Nothing in the record links to a ticket, because Gherkin already has the
  room. A tag and the free description under `Feature:` carry the ticket
  id, its URL, and the acceptance criteria in the reviewer's own words;
  freezing the feature freezes all of it. nukadoko has no concept of a
  ticket and needs none.
- There is no plan subsystem and no reasoning field. The question "what
  would prove this?" is answered by the feature file and the typed steps it
  binds to, and the judgment that the scenario really expresses the
  criteria is made where the translation happens — in PR review of that
  feature, the git-native way. A sign-off is the record that the agreed
  check actually ran.

A sign-off only ever speaks in the past tense, and that is what keeps it
from rotting the way a requirements traceability matrix does. A matrix
claims to describe the system as it is now, so it drifts the moment the
system moves; "green at commit X" stays true forever. What the record
deliberately does not claim is that the software still behaves that way
today.

### The acceptance loop

What an agent does when a ticket's acceptance criteria are handed to it:

1. Read the vocabulary — `nuka steps --json`, then `nuka describe <step>`
   for the contract of anything that looks relevant.
2. When an operation is missing, `nuka scaffold <name>`, implement it, and
   exercise it alone with `nuka do` until its receipt looks right.
3. Write the feature. A tag and the description under `Feature:` carry the
   ticket id and the criteria in the reviewer's words; the scenarios are
   those criteria translated into the vocabulary.
4. `nuka check <feature>` — undefined steps, pattern/schema mismatches, a
   Then bound to a mutating step — before anything runs. The argument is not
   optional in spirit here: an acceptance feature living outside
   `featuresDir` is exactly what a bare `nuka check` does not walk.
5. Commit. A run can only be frozen if it happened on a clean tree at the
   commit still checked out, so debugging runs against a dirty tree are
   fine; they simply cannot be accepted.
6. `nuka run <feature>` until green.
7. `nuka accept <feature>`, then commit the record it wrote.

Steps 1-4 are where the work and the review are: new typed steps and the
feature itself are ordinary PR material, and the translation from criteria
to scenarios is the judgment a reviewer is there to check. Steps 5-7 are
mechanical, and the tool refuses rather than let them go wrong quietly.

## Allure emitter

`nuka run` writes one Allure test result per scenario to the `allure-results/`
directory (Allure 2 file format, readable by both Allure 2 and 3) —
nukadoko's only presentation layer; nukadoko itself renders nothing.

- The output location defaults to `.nukadoko/allure-results/` (the state
  directory's own `allure-results/`, above); `allure.resultsDir` in
  `nukadoko.config.ts` moves it to any other root-relative path. There is no
  `enabled` flag and no CLI flag — the emitter always runs, so zero
  configuration already produces a full report. It is skipped only when a
  `nuka run` invocation selects zero pickles (no `allure-results/` is
  created at all in that case), the same reason BeforeAll/AfterAll are
  skipped for it.
- Writing is append-only: an existing `allure-results/` directory is never
  cleared or replaced. Whether two `nuka run` invocations count as one
  Allure launch or two is left to the caller; a user who wants a fresh
  launch removes the directory themselves.
- A scenario run maps to one Allure test result: each gherkin step becomes
  an Allure step, and each Before/After hook becomes its own fixture
  (Allure container).
- Attachments: the scenario's own trace and screenshot, and per step, its
  HTTP log and its validated result. Separately, whatever a step declared
  about itself — an attachment, a link, a log line — is emitted too, always
  under a name prefixed `declared:`; that prefix is the one place where
  provenance (measured by nukadoko vs. self-reported by the step) survives
  once everything is sitting in the same result file.
- A step's parameters carry its declaration and what was actually observed
  side by side: `mutates (declared)` next to the measured `http reads
  (observed)` / `http writes (observed)` (and, for a compat step, `world
  reads (observed)` / `world writes (observed)`) — not because the two are
  checked against each other automatically, but so a reviewer can: the
  declaration is what nukadoko trusts and acts on, the observed counts are
  what actually happened, and this row is where the two sit close enough to
  compare by eye. The observed side is an HTTP-method proxy, not a semantic
  judgment (see Keyword semantics): a row can show a truthful `mutates
  (declared): false` next to a nonzero `http writes (observed)` when the
  step called a POST-based read, and that is the proxy showing through the
  table, not either number lying.
- A failed step or test's message is prefixed `[nukadoko.failure=<kind>]`,
  naming the same `error.kind` its receipt already carries; the same
  `error.kind` is also written as a `nukadoko.failure` result label. The two
  Allure generations turn that into a category by different paths, and they
  need different things from a user.
- **Allure 2** has no per-result category field, so the emitter also writes
  `categories.json` (one rule per `error.kind`, all seven, every run,
  matching the message prefix by regex) — the message prefix and the
  category rule are two views of the same classification, and no user
  configuration is needed.
- **Allure 3**'s `allure generate`/`allure report` never read a results
  directory's `categories.json` — categories there come only from Allure 3's
  own config, matched against a result's labels, and `nukadoko.failure` is
  exactly such a label. `examples/allure/allurerc.mjs` ships seven
  label-matcher rules, one per `error.kind`; dropped at a project's root it
  is picked up automatically (Allure 3 auto-detects
  `allurerc.{js,mjs,cjs,json,yaml,yml}` from the current working directory,
  no `--config` flag needed). Without it, every nukadoko failure lands in
  Allure 3's one built-in "Product errors" category instead.
- Identity (`fullName`/`testCaseId`/`historyId`) is computed the same way
  the official cucumberjs Allure adapter computes it, so a team migrating
  onto nukadoko keeps its existing Allure history and retry tracking intact.
- Ad-hoc `do` receipts are working records, not test results, and do not
  appear on the dashboard — what an exploration proves is expressed by
  repairing or writing a scenario, and that scenario run is what Allure
  shows.
- Viewing, history, trends, flakiness: all Allure's job. nukadoko has no web UI.

Not yet built: a hook's own duration (record.json carries no per-hook
timestamp today, so a hook's start and stop both collapse to the
scenario's own boundary), BeforeAll/AfterAll (no run-level record exists
for the emitter to map from), and link-template configuration (mapping a
tag like `@issue:123` to a URL).

The point is not format politics: a classic cucumber run fills an Allure
report only where glue authors hand-attached evidence, while nukadoko's
harness measures everything anyway — and Allure's own model (attachments,
labels, parameters) already had a first-class place for all of it. The
Allure emitter is where nukadoko's measurement surplus becomes visible,
automatically, today; the messages emitter below is the second, narrower
output, and its job is compat fidelity rather than measurement surplus.

## Messages emitter

`nuka run` writes one cucumber messages stream — NDJSON, one envelope per
line, via `@cucumber/messages` — per invocation, defaulting to
`.nukadoko/messages.ndjson`; `messages.output` in `nukadoko.config.ts`
moves it to any other root-relative path. There is no `enabled` flag and
no CLI flag, the same as Allure — the emitter always runs, and it is
skipped only when a `nuka run` invocation selects zero pickles.

- One run is one stream is one file: `begin` truncates the output rather
  than appending, because appending would leave two `testRunStarted`
  envelopes in one file — no longer a single well-formed stream to read
  back. `nuka run` runs one feature per invocation, so running a second
  feature afterward overwrites the first stream — the intended consequence
  of "one file, truncated," not an oversight.
- This emitter's role is the Allure emitter's inverse. Allure is where
  nukadoko's measurement surplus becomes visible; this one is compat
  fidelity, full stop — its only job is that a migrated suite's existing
  formatters and JUnit-based CI keep reading a nukadoko-produced run the
  way they read a classic cucumber-js one.
- Receipt internals stay out of the stream entirely — no validated result,
  no `mutates`, no `observed` counts, no `error.kind`. `TestStepResult` and
  `TestStepFinished` are closed schemas (`additionalProperties: false`)
  with no field for any of them, and there is no smuggling them in through
  a marker the way Allure's own `[nukadoko.failure=<kind>]` label does.
- Attachments are limited to what a step declared about itself: `declared`
  attachments and log lines, the latter riding cucumber-js's own
  `text/x.cucumber.log+plain` media type (the one `this.log()` produces).
  Trace, screenshots, the HTTP log, and the validated result stay
  Allure-only — that measurement surplus already has a home, and
  base64-embedding a trace here would bloat the stream for no consumer
  that wants it.
- `testRunFinished.success` always matches the run's own exit code.
  BeforeAll/AfterAll have no place to write into this stream (no
  run-scope record exists for the emitter to draw from), so a run whose
  run-scope hook failed shows up only here, never inside any one
  scenario.
- Confirmed against a real consumer, not just self-consistent by
  construction: piping our own `messages.ndjson` through
  `@cucumber/junit-xml-formatter@0.14.0` (which drives `@cucumber/query`
  over the envelope stream) throws nothing, and every id it needs to
  resolve — pickle to testCase to testStepFinished, `pickleStepId` back to
  the gherkin step — does resolve. A failed scenario's `<failure>` carries
  the step's own error message, `<system-out>` carries a per-step
  passed/failed/skipped trace, and `<testsuite tests="...">` matches the
  real scenario count; `<failure>` itself gets no `type` or `message`
  attribute, because `TestStepResult.exception` is never set (below).
  Only the junit-xml path has been run this way — an official HTML report
  or a third-party formatter has not been exercised against this stream,
  so what's confirmed is that this is a well-formed cucumber messages
  stream a real consumer reads without error, not that every existing
  formatter renders it.

Honest limits, named rather than hidden: hooks collapse to one generic
Before and one generic After, since a scenario record has no record of
which individual registration ran; a hook's own duration is always zero,
the same limit the Allure emitter carries; `declared` labels, links, and
parameters have no slot in the protocol's closed schema and are dropped;
no `stepDefinition` envelope is emitted, because the record keeps no
location for a step's own definition and emitting one anyway would be a
fabricated fact; and `TestStepResult.exception` is never set, since the
protocol requires `Exception.type` and a receipt only ever carries a
message — the reason a failed step's JUnit `<failure>` is body-only.

## Self-healing, audited

When a scripted scenario breaks (the app changed, the pattern no longer
matches reality), the repair loop is:

1. An agent re-runs the goal adaptively via `nuka do`, one step at a time,
   reading each receipt to decide the next call.
2. The receipts record what actually worked — a sequence that deviates from
   the scripted scenario. They are the narrative, not the proof: the agent
   may cite them in the PR as the story of the repair.
3. The PR updates the typed steps and/or the feature file, and its proof is
   the repaired scenario running green — a scenario record and its
   receipts, reviewed like any other change. Attestation always flows
   through the scenario, never through an ad-hoc sequence.

nukadoko's contribution is that every stage leaves a record; the authoring is an
agent workflow (bundled skill), not engine magic. Self-healing without an
audit trail is how test suites silently stop testing anything — the deviation
record is the point.

## Tending

`nuka check` answers one question: can this project run right now. A
project can pass it every time and still be rotting. A sign-off can stop
describing the code it froze. A declaration can go years without anything
exercising it. A contract can be unreadable to the agent that has to pick
it. None of that stops a run, and all of it costs more the longer it sits —
which is the failure mode this tool is named after. A nukadoko tended
daily matures; neglected, it dies.

`nuka tend` answers the other question: is this vocabulary, and the record
it has produced, still healthy.

The reason it is a separate command rather than more warnings on `check`
is that the two are read at different moments and mean different things.
`check` runs before every run, in CI, inside an agent's loop, and every
line it prints is something standing between the project and a green run —
which is why a finding there has to be worth stopping for. Tending
findings are not: nothing here has to be fixed today, and if they appeared
on every `check`, they would teach everyone to skim past the line that
did have to be fixed. Noise is not a cosmetic problem in a tool whose main
claim is that its checks are worth reading.

Before any finding, `tend` states where the bed currently is: how much of
the vocabulary is typed rather than still compat, and how much of what a
typed step could declare is actually declared. This is not a finding and
does not touch the exit code — a suite in the middle of a migration is in a
normal state, not a faulty one, and warning about it every time would
drown the findings that do need acting on.

It exists because the information was already there and unread. A receipt's
`world` and `declared` counts do shrink as a suite promotes, which is true
and useless as a way for a person to see progress: nobody reads a directory
of receipts to work out how far along they are. Stating it once, in the
command whose whole subject is the health of the bed, is what makes it
something anyone actually sees.

What it looks at, and why each one is rot rather than style:

- **A sign-off that no longer matches the code it froze.** A record
  carries the feature source it accepted and every receipt from that run.
  If a frozen `result` no longer passes its step's current `returns`
  schema, or the frozen feature source no longer matches the file it was
  taken from, or a step it cites is gone from the vocabulary, then the
  record is still on disk making a claim it can no longer support. This
  is the one finding here that is an error rather than a note: a sign-off
  that has quietly stopped meaning what it says is worse than no sign-off,
  because it is still being counted.
- **A `from` declaration nothing exercises.** Every occurrence of the step
  across every feature captures that key from the line, so the declared
  producer never supplies anything. Reported as the fact it is — the
  declaration may still be reached through `nuka do --use` — not as a
  verdict that it should be deleted.
- **A step with a pattern that no feature binds.** A step meant only for
  the CLI should have no pattern at all; one that has a pattern is
  claiming a place in a scenario it does not occupy.
- **A schema field with no `.describe()`.** This is the tending finding
  aimed squarely at the agent: `nuka describe` is how an agent learns what
  a field means, and a field with no description tells it nothing a name
  did not already. Human readers of the step file can see the surrounding
  code; the agent choosing between two steps cannot.
- **A step with no `rationale`.** `description` says what the step does,
  which is enough to call it. `rationale` says why it is built this way and
  what was rejected, which is what an agent needs before deciding it may
  rewrite the step. Missing, every rewrite is uninformed.
- **A configured parameter type no pattern uses.** Dead configuration,
  reported like any other.
- **A `defineParameterType` still registered from support code.** It keeps
  working, and `config.parameterTypes` is its typed-era home; moving the
  registration changes no match. This one used to be a `nuka check`
  warning, which was a mis-sort: it appears for as long as a suite has any
  compat left, which is a normal state to be in, and printing it before
  every run trains people past the lines that do stop a run.
- **A `secrets.public` or `secrets.redact` entry naming a key no envFile
  defines.** A real instruction reaching nothing — configuration that has
  drifted from the files it describes. Also moved from `check` for the same
  reason: nothing about it changes whether this run should happen. Its
  neighbors stay on `check` and are worth the contrast — a `redact` entry
  whose value is too short to be redacted, and a tracked env file with a
  secret-looking key, both mean plaintext reaches a log the moment the run
  starts, which is exactly something to know beforehand.

Findings are `--json` like everything else. The sign-off finding exits
non-zero so a periodic job can act on it; the rest do not, because a
project is allowed to carry them.

`tend` reports and does not repair. Fixing means writing a description,
deleting a step, or re-accepting a feature — decisions with an author
behind them, which is the same reason `accept` refuses rather than
fixes up a dirty tree.

## CLI summary

The npm package is `nukadoko`; the one command it installs is `nuka`.

```
nuka run <feature[:line]>     execute scenarios; receipts + allure-results
nuka do <step> --args '<json>' [--use <receipt-id>]
                              execute one typed step; receipt to stdout.
                              --use supplies its `from` keys from an
                              earlier execution's result
nuka steps [--json]           list the whole vocabulary, typed and compat:
                              name, patterns, description, mutates, and
                              where each chained args key comes from
nuka describe <step>          full contract, schemas as JSON Schema, plus
                              rationale when the step declared one
nuka scaffold <name>          typed step template that fails until implemented
nuka check [feature]          static checks: pattern/schema mismatches, Then
                              binding to mutating steps, undefined steps per
                              feature, ambiguous steps (one line two patterns
                              both match), duplicate patterns, a required
                              args key nothing on that line could fill, a
                              required `from` key whose producer is absent,
                              bound later in the scenario, or ambiguous
                              between two producers, a `from` naming a step
                              discovery never registered, config
                              coherence, unreadable step files (reported,
                              not fatal — the rest of the project is still
                              checked), unsupported hook tag expressions;
                              a feature argument checks that one file
                              instead of featuresDir, for a feature living
                              outside it
nuka accept <feature>         freeze that feature's last green run as a
                              committed acceptance record beside it
nuka tend [--json]            where the bed is, then what is rotting rather
                              than what is broken: how much of the
                              vocabulary is typed rather than compat and
                              how much of it declares what it could, then
                              a sign-off that no longer matches the code it
                              froze (the one finding that exits non-zero),
                              a `from` nothing exercises, a patterned step
                              no feature binds, a schema field with no
                              `.describe()`, a step with no `rationale`, a
                              configured parameter type no pattern uses, a
                              `defineParameterType` still registered from
                              support code, a secrets entry naming a key no
                              envFile defines
nuka session list|clear
nuka init [--base-url <url>] [--features-dir <dir>]
                              set up a project; ends with a self-check
nuka skill path               where the bundled skill lives, for a project
                              that wants the copy matching this nukadoko
```

Text output (no `--json`) is formatted for a human reading a terminal; `--json` is the machine-readable contract.

## Out of scope (honest limits)

- Semantic truth of a step's implementation rests on PR review. The tool
  guarantees the shape of inputs/outputs and the fact of execution.
- nukadoko cannot stop an agent with shell access from reading `.env` directly;
  it removes the structural necessity of secrets passing through the agent's
  context.
- A sign-off is not a proof that the software is correct. It records that an
  agreed scenario was green at one named commit, and says nothing about today.
- **Promoting a step to `defineStep` is one-way.** The migration door's
  promise covers compat assets: switching the import back leaves a plain
  cucumber-js suite. `defineStep` has no import to switch back to. A
  promoted step's body still moves — it is written against Playwright's own
  objects, by the same choice stated below — but its schemas, its receipt's
  `result`, `from` and the binding-order check reading it, and every
  contract check built on those do not, and nothing here converts one back.
  Stated as a limit rather than a gap to close: the conversion is per-step
  and mechanical, and the import's reversibility exists to make adoption's
  first step cheap, not to make the typed side optional.
- **Not driver-agnostic, deliberately.** `ctx.page()` and `ctx.request()`
  return Playwright's own `Page` and `APIRequestContext`, and the compat
  door hands migrating glue the same objects it already used. Wrapping them
  behind an interface of nukadoko's own would cost every capability the
  wrapper didn't think to expose, and would replace a vocabulary users
  already know with one only this tool speaks — the opposite of writing
  through the official SDK. The exchange is that swapping in another driver
  later breaks the public API and the compat door together. That is
  accepted, not overlooked: rewriting step bodies from one driver's API to
  another is work an agent does well, while paying for portability up front
  would slow every change that isn't a driver swap. Revisit when the
  probability of that swap is measured to have risen, not before.
- No test parallelism, sharding, retries, or CI reporting. No outbound
  network I/O by nukadoko itself. No HTML rendering — that is Allure's job.

## Roadmap

- **M1 — engine core**: `defineStep`, `do`, `run` over pickles, receipts,
  sessions/environments, `check`, `init`. Secrets onboarding redesigned.
- **M2 — compat API**: `nukadoko/compat` (Given/When/Then/World/hooks subset),
  migration guide for cucumber-js + Playwright suites.
- **M3 — reporting interop**: a cucumber messages (NDJSON) emitter for
  scenario runs — the compatibility surface that keeps a migrating team's
  existing formatters, JUnit-based CI, and HTML reports working — plus the
  allure-results emitter as the flagship dashboard.
- **M4 — sign-off**: `nuka accept`, the commit and cleanliness checks it
  refuses on, and the frozen record written beside the feature.
- **M5 — skills**: the skills nukadoko ships, and `nuka skill path`. The
  CLI is deliberately a set of small verbs; a skill is what turns them into
  a workflow an agent can follow without being told, and none of it changes
  the engine. Skills follow the Agent Skills specification, so `gh skill
  install` and a Claude Code plugin marketplace both distribute them across
  hosts; nukadoko does not copy files into any host's directory itself.
  `nuka skill path` exists for the one thing neither of those can offer —
  the skill that shipped with the installed nukadoko, at the version that
  installed it, since a skill describes a CLI and drifts into fiction when
  the two diverge. Two ship. The **acceptance skill** drives the acceptance
  loop end to end — criteria in, vocabulary read with `steps` and
  `describe`, missing operations scaffolded and implemented, the scenario
  written, then `run` until green and `accept`. The **migration skill**
  carries what the compat audit measured: the gaps a real cucumber-js suite
  actually hits, in the order they bite rather than the order they are
  documented. Its first stage leans on `nuka check` reporting those gaps,
  which `nuka check` now does (see "Compat steps").
  Neither writes down a fact the CLI already answers — vocabulary,
  contracts, refusal reasons — because a skill that copies those starts
  lying the moment the command changes.
- **M6 — chained arguments**: `from`, the scenario-order check `nuka check`
  and `nuka run` share, `--use` on `do`, and a `used` entry that names the
  step beside the receipt it cites. Where a step's inputs come from stops
  being prose inside a `run` body and becomes a declaration the tool reads
  (see "Chaining steps").
- **M7 — tending**: `nuka tend`, the findings that are about rot rather
  than breakage (see "Tending"). Kept off `nuka check` on purpose: `check`
  is read before every run and has to stay worth stopping for.
- **Later**: AI-assisted glue converter (existing regex glue → typed steps),
  scenario harvesting (generate feature files from recorded `do` sequences),
  tag-expression filtering, cucumber-js adapter if a real suite needs
  in-place coexistence rather than migration.

## Implementation notes

- Runtime dependencies: `@cucumber/gherkin`,
  `@cucumber/cucumber-expressions`, `@cucumber/messages`,
  `allure-js-commons`, `playwright`, `zod`, `tsx` (runtime TS import),
  `yargs` (CLI). Node >= 20.
- When a format or protocol has an official SDK, nukadoko writes through it
  rather than reimplementing the format — allure-results through
  allure-js-commons' reporter machinery, cucumber messages through
  `@cucumber/messages` — and stays a thin mapping layer on top. Overriding
  a piece of the official machinery is a measured decision taken when a
  concrete need appears, never the default.
- id format: `<kind>-<timestamp>-<short random>`.
- `nuka steps` and `nuka describe` import step modules — collecting compat
  registrations and patterns requires it — and importing executes a file's
  top-level code, the same caution as running. Shell completion never
  imports: typed step names complete from file names, ids and session names
  from the state directory, so TAB stays fast regardless of vocabulary size.
- The first real-world validation gate (before M2 is designed in detail):
  bind ~10 real feature files and measure whether reviewing AI-drafted typed
  steps actually beats writing glue by hand. Run against 11 feature files
  from seven public projects; the answer was yes in six of the seven. The
  second gate measured the compat door rather than the typed one, and is
  reported under Compat steps above.
