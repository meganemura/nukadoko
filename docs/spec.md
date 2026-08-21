# nukadoko specification

> nukadoko, a living pickling bed for your Gherkin: typed steps, step records, and an agent-first CLI.

Status: M1 (engine core) implemented (`steps`/`describe`/`do`/`run`/
`check`/`init`/`scaffold`, sessions, environments, secrets). M2 (compat,
below) is implemented too (`nukadoko/compat`, typed World measurement, and
a migration guide). Both real-world gates have now been run: typed steps
drafted against real feature files, and the compat door audited against
real cucumber-js glue (below). Still 0.x; of M3+, the Allure emitter and the
messages emitter are both implemented, and so are sign-off (`nuka accept`)
and both of M5's skills. Compat gap detection in `nuka check` (the
migration skill's own prerequisite) is implemented too (see "Compat steps"
and docs/migration.md's "The dashboard is `nuka check`"), closing out
M1-M5.

## What nukadoko is

nukadoko is an agent-first engine that runs Gherkin. Humans write and review the durable
artifacts (feature files, typed step definitions, sign-off records) and
agents execute them. Everything about the runtime is optimized for an agent's
trial-and-error loop: every step has a typed contract, every step can be run
on its own from the CLI, and every execution leaves a step record the tool
wrote rather than the agent. Not a step record the agent *cannot* forge (an
agent with shell access can write any file) but one it never had to be
asked to produce (see "Out of scope").

Agent-first is a design constraint, not a slogan. An agent must be able to
complete the whole loop unassisted: discover the vocabulary
(`nuka steps --json`), read a contract (`nuka describe`, schemas as JSON
Schema), execute one step (`nuka do`, step record on stdout, meaningful exit
code), read the validated result, and decide the next call. When the
vocabulary lacks an operation, the agent scaffolds and implements a new step
and a human reviews the PR. Every interface has a machine-readable form
(`--json`); rich human reporting is delegated to Allure.

One consequence of that constraint deserves stating on its own, because it
directs where this tool grows. End-to-end execution is expensive in a way
unit tests are not: a browser, a real target, minutes. So how much of a
scenario can be judged wrong **without running it** is, in practice, how
fast anyone iterates on it, and for an agent, whose loop is made of cheap
commands, it is directly how fast it can correct its own work. Every
declaration this spec asks for is partly paid for that way: `pattern` and
`args` let `check` reject a line before a browser opens, `mutates` lets it
question a Then, `from` lets it reject a scenario whose steps are in an
order that could only fail. Widening what `nuka check` can settle is
therefore a first-class goal here, not a convenience, and the standing
question after any failed run is whether a check could have caught it
first. The limit is honesty, not ambition: `check` only claims what can
*only* end one way, since a check that guesses trains people to ignore the
ones that don't.

A nukadoko is the fermented rice-bran bed that turns cucumbers into pickles.
It is alive: tended daily it matures, neglected it dies. That is the claim
this tool makes about step definitions (they are a living culture, not a
write-once test asset), and the agent is what tends them.

nukadoko deliberately owns as little as possible:

| Concern | Owner |
|---|---|
| Gherkin syntax (Background, Scenario Outline, tables, docstrings, tags) | `@cucumber/gherkin`: the official parser compiles features into flat "pickles" |
| Step pattern matching (`{string}`, `{int}`, custom parameter types) | `@cucumber/cucumber-expressions` |
| Pretty reports | Allure: nukadoko emits `allure-results`, never renders HTML |
| Approval of what-would-prove-what | git: PR review of features and step definitions, CODEOWNERS |
| **Typed step contracts** | **nukadoko** |
| **Execution and measurement (records)** | **nukadoko** |
| **Sessions, environments, secrets** | **nukadoko** |
| **Keyword semantics (Then must not mutate)** | **nukadoko** |
| **Sign-off records** | **nukadoko** |

## Problem

Two independent rots meet here.

**BDD rot.** In Cucumber, step definitions are glue bound by patterns to
prose. The glue library decays invisibly: duplicated steps accumulate,
undefined steps surface only at run time, nothing types what a step consumes
or produces, and the report can only say "passed": there is no record of
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

## Artifacts

Everything nukadoko touches falls into one of five kinds, by who writes it,
whether it belongs in the repository, and how long it is meant to live:

| Purpose | Artifact | Written by | Committed | Lifetime | Read by |
|---|---|---|---|---|---|
| Contract | `.feature`, step definitions, `nukadoko.config.ts` | a human | yes | permanent | humans, the engine |
| Measurement | `.nukadoko/records/steps/<id>/` (`record.json` and its evidence), `.nukadoko/records/scenarios/<id>` | the tool | no | one run | `nuka accept`, the Allure and messages emitters, `nuka do --use` |
| Sign-off | `<feature-basename>.<date>-<sha>.<environment>.<browser>.md`, beside the feature | the tool (`nuka accept`) | yes | permanent | humans, PR review, `nuka tend` |
| Export | `.nukadoko/export/allure-results/`, `.nukadoko/export/messages.ndjson` | the tool | no | disposable | other tools |
| Cache | `.nukadoko/cache/sessions/` | the tool | no | disposable | `nuka run` / `nuka do` |

The table names files; the distinctions behind the columns are what answer
"what happens if this is deleted" and "who gets to change it":

- **Export is disposable because it is derived.** Delete it and the next
  `nuka run` writes a fresh one: it exists for a reader outside nukadoko
  (Allure's own CLI, a CI formatter), never for nukadoko itself.
- **Cache is disposable for a different reason.** It is not a record of
  anything that happened, only work avoided: a session file lets a later
  call skip logging in again. Deleting it costs a login, never correctness.
- **Only Contract and Sign-off are committed.** One is the promise a human
  wrote and reviewed; the other is the claim the tool froze once that
  promise ran green. Measurement is never committed: `nuka init` gitignores
  the state directory it lives under, because a working record of one run
  has nothing to say about the next one.
- **Step records and scenario records share one row.** They differ only in
  grain: a scenario's own record and each of its steps' own records answer
  the same question at two resolutions, not two different ones. `nuka do`
  has no scenario to write one for, so only the step side exists there; the
  word for both is "record", and the file split is a grain, not a second
  concept.

## Typed steps

nukadoko follows Cucumber's layout convention: feature files and the code that
supports them live together under `features/`, so a migrating team keeps its
mental model and its directory tree. The suggested home for typed steps is
`features/steps/`, 1 step = 1 file: `features/steps/<name>.ts` (kebab-case;
the file name is the step name).

Discovery walks `featuresDir` for every `.ts`, `.mts`, `.js`, and `.mjs`
file (whichever extension a file has, the step's name comes off that same
extension), skipping `node_modules` and any dot-directory (`.git`,
`.nukadoko`, an editor's own `.vscode`) at every depth, and excluding
`.d.ts`/`.d.mts`: a type declaration, not a step definition. A `.cjs` file
is walked far enough to be named, never imported: nukadoko is ESM-only (see
"Compat steps" below for the same CommonJS go/no-go), so `nuka check`
reports it as `step-file-unsupported-extension` instead of letting whatever
it defines resurface as an unexplained `undefined-step`. Setting
`featuresDir` to something wide (a repository root, for instance) widens
this same walk, so a build artifact sitting anywhere in that tree can be
read as glue if its own name happens to end in one of the four extensions
above; `node_modules` and every dot-directory stay excluded regardless of
how wide `featuresDir` is set.

```ts
import { defineStep } from "nukadoko";
import { z } from "zod";

export default defineStep({
  pattern: "a project {name:string} exists",  // named capture, see below
  description: "Create a project and return its id",
  args: z.object({ name: z.string() }),
  returns: z.object({ id: z.string(), name: z.string() }),
  mutates: true,                               // default true; see keyword semantics
  async run({ request }, args) {
    const res = await request.post("/projects", { data: args });
    return res.json();
  },
});
```

- `pattern` binds the step to Gherkin text. `patterns: [...]` allows
  aliases; giving both concatenates them, `pattern` first. A step may omit
  patterns entirely: then it is CLI-only
  vocabulary for agents, invisible to feature files but importable by other
  steps: a typed building block, whose `args`/`returns` schemas keep the
  composition checked.
- Every parameter in a pattern is named: `{key:type}` binds that capture to
  the args key `key`. Matching strips the names and hands plain `{type}` to
  `@cucumber/cucumber-expressions`: the syntax owner is unchanged, names
  are a thin layer above it. Names are required (an unnamed `{string}` in a
  pattern is a `nuka check` error) because the alternative (binding
  captures to schema keys by declaration order) swaps two same-typed
  values silently when keys are reordered, and no static check can catch
  that. The binding must survive review by being visible in the pattern
  itself. Aliases must all bind the same key set.
- A pattern's literal text is still cucumber-expressions syntax, not free
  prose: bare `(` `)` mean optional text and bare `/` means alternation, so
  literal occurrences must be escaped, as `\\(`, `\\)`, `\\/` in the
  `pattern` string literal (one backslash in the parsed expression means
  two in TS source), to match literally. Unlike a schema mismatch, an
  unescaped occurrence still compiles (`nuka check` passes and the step
  registers), and the pattern then silently never matches the pickle text
  it was written for (hit independently in two corpora during validation).
- A parameter cannot appear inside an optional group: an inherited
  cucumber-expressions constraint. The constraint binds the group syntax,
  not the parameter itself: a custom parameter type whose own regexp is
  optional (a `{dir:from-dir}` matching `( from '…')?` or nothing) is
  legal, and is the intended way to fold "the same step with a trailing
  location clause" into one definition: pair it with an `.optional()`
  args key. Without a custom type, each variant needs its own step
  definition.
- Aliases are for prose that is genuinely interchangeable at the args
  level: same keys, same `run()` behavior no matter which phrasing
  matched. If `run()` needs to know which variant matched (behavior forks
  on the phrasing itself), give each variant its own step even when their
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
  schema key that nothing on a given line could fill (no capture, no
  table/docstring, no `from`), because that line can only ever fail args
  validation. The second direction went unchecked for a while, on the
  reasoning that a key might be filled some way the tool could not see;
  `from` closed that gap by making the remaining way visible, so what is
  left is genuinely unfillable rather than merely unexplained.
- A data table or docstring attached to the step binds to the one required
  args key the named captures left unconsumed (tables as `string[][]`,
  docstrings as `string`), validated by the schema like everything else.
  Gherkin tables get types for the first time. Zero or several unconsumed
  required keys with an attachment present is a `check`/`run` error; no
  reserved key name exists.
- `from` declares where an args key's value comes from when the pattern
  did not capture it: `from: { projectId: [createProject, "id"] }` reads as
  "`projectId` is the `id` of whatever `createProject` returned earlier in
  this scenario". The executor fills the key in before args validation, so
  the key stays required and the schema keeps saying what the step actually
  demands. A key name, never a transform, and a key may list several
  mutually exclusive producers (see "Chaining steps" for why that limit is
  the point, for how alternatives are resolved, and for what to do when a
  key name is not enough).
- What `returns` carries decides what a failure can be diagnosed from, so
  "return what later steps cite" is the wrong rule to design it by. That
  rule drops every value this step's own correctness depends on but
  nothing downstream reads (the date it computed, the id it picked, the
  name it resolved before sending), and those are precisely the values a
  step record is interrogated for once a run has gone wrong. Returned, they
  are on the step record as validated facts and the question "what did it
  actually send" has an answer; withheld, the answer has to be
  reconstructed from an error message written by someone else's system.
  This is `observed` and `sections`' own measure-and-keep reasoning
  applied to the one field the step itself fills in.
- An observation that claims absence (`visible: false`, `count: 0`, an
  empty string) is ambiguous in exactly the way its presence-claiming
  counterpart is not: the target may genuinely not be there, or the page
  may simply not have finished rendering yet, and those two situations
  produce the identical value on the step record unless the step says
  otherwise. A step whose `returns` can carry absence should carry, beside
  it, whatever proves the read itself was valid: that the page had
  reached a state where absence was a real answer rather than a symptom of
  asking too soon. Without that, every hypothesis a reviewer could form
  from the step record is equally consistent with it, which is what
  unfalsifiable means in practice. Presence needs no such companion:
  `visible: true` is its own proof that the read landed on a rendered
  page, since neither a hidden nor an unrendered element can produce
  `true`. That asymmetry (a positive claim vouches for itself, a negative
  one does not) is the reason to treat the two differently rather than
  applying one convention to both. It bites hardest exactly where it looks
  irrelevant: an acceptance criterion phrased "hidden unless the condition
  holds" is satisfied by the same `false` an unrendered page also
  produces, so a scenario asserting it can go green while the page never
  finished loading: green for the wrong reason, indistinguishable from
  green for the right one without readiness evidence on the step record. A
  tool whose purpose is tying acceptance criteria to an execution that
  either happened or did not cannot treat that as a minor gap; it is the
  gap.
- `mutates` (default `true`): whether the step changes state anywhere it
  touches. Read-only steps declare `mutates: false`.
- `parts` (default `[]`) lists the steps this step's own `run` may call
  through the `call` fixture (see "Parts"). A step that calls none of
  them omits it, the same convention `from` follows.
- `rationale` is optional with no default: omitted, `Step.rationale` is
  `undefined`, the same convention as `pattern`. It answers a different
  question than `description`: `description` is what the step does, the
  information `nuka steps` lists so an agent can pick which step to call;
  `rationale` is why it is implemented this way and what was tried and
  rejected, the information an agent needs before deciding it may rewrite
  the step. It never appears in `nuka steps`' listing (only
  `nuka describe` shows it) and never in a step record: a step record
  records one execution, and rationale is a property of the contract that
  would be identical in every record for the step, not something that
  execution produced.
- The `run` body is free TypeScript on the fixtures it destructured.
  Composition is importing another step module and calling its `run` with
  the same fixture bag. Shared helpers live in ordinary modules (e.g.
  `features/steps/lib/`).
- Semantic correctness (whether the implementation truthfully performs what
  the description and pattern claim) is guaranteed by PR review, not by the
  tool. Protect `steps/` with CODEOWNERS.

### Context API

A step's `run` takes a **fixture bag**, ordered by name in a plain
destructuring pattern: `run({ page, section }, args)`. Only the names a
step actually destructures are ever built: a step that never names `page`
or `context` causes no browser to launch, at all, for that step.

That last sentence is not this section's design goal, it is a consequence
of the real one. `run({ page }, args)` is not shorthand for "give me the
page": it is the same object literal `check` parses without ever calling
`run`, the same way it already parses `pattern`/`args`/`returns`/`from`
without executing anything. Naming `page` is therefore not an action a step
performs at run time; it is a declaration a step makes at file-write time,
readable before any of it runs. `check` reads that declaration by parsing
`run`'s own source text, never by calling it, and what actually gets built
follows the same declaration, so there is no way for the two to disagree:
a step cannot claim, at the top of its file, to need nothing the
declaration didn't ask for, because the declaration *is* what gets built.
This is the same shape `from` (see "Chaining steps") already established
for a step's own *output* (a static declaration that drives execution
instead of merely describing it after the fact), applied here to a
*resource* instead. Playwright fixtures use the identical destructuring
syntax, but that is not the reason for the design: to Playwright, the
pattern is a construction instruction for its own runner; to nukadoko, it
is first a declaration `check` reads, and a construction instruction only
as a consequence of being one.

The fixture names:

- `page: Page`: Playwright Page, restored from the session's storageState,
  with the configured baseURL wired into the browser context so
  `page.goto("/path")` resolves against it. The browser launches when a
  step's own bag is built, and only when `page` (or `context`, below) is
  one of the names it destructured, never earlier, and never for a step
  that names neither.
- `context: BrowserContext`: the `BrowserContext` `page` already belongs
  to (`page.context()`), never a second one. Exists for a step that needs
  a second tab (`context.newPage()`) without reaching past the executor
  for a `browser` it does not expose (below).
- `request: APIRequestContext`: Playwright APIRequestContext with the
  session's cookies. `baseURL` is optional here, the same as `page` above:
  a suite that only ever calls absolute URLs across multiple hosts has no
  single baseURL to state, and nukadoko does not force one into config just
  to satisfy this fixture. If `baseURL` is unset and a step passes a
  relative path anyway, the resulting failure is Playwright's own; nukadoko
  does not re-implement its URL resolution to pre-empt it.
- `env`: environment variables from the configured envFiles (read-only).
  Not a convenience: it is where determinism (the process environment is
  never merged) and secrets redaction (only values nukadoko itself loaded
  are redactable) are enforced.
- `requireEnv(name)`: the same value as `env[name]`, minus the presence
  check every step reading a required variable ended up writing for
  itself; it returns `string`, never `undefined`, by throwing instead of
  returning one. Empty string counts as missing too: an envFile's `KEY=`
  line parses to `""`, not to "key omitted", and a step that declared a
  variable required is exactly as broken either way. The error names the
  key only, never a value (there is no value to show for a missing one,
  and a shape that never carries values cannot become a redaction gap
  later), and it cannot say which envFile to fix, because this fixture
  only ever sees the merged result, never `config.envFiles`'s list. `env`
  stays for the rare step that wants every key at once. Every name
  `requireEnv` is called with, whether that call finds a value or throws,
  is recorded on the step record's `required_env` (see "Records"), in read
  order, deduplicated. Reading the same value straight off `env` leaves no
  trace: that path is a plain object, and the library never sees it.
- `baseURL`: the configured baseURL, for the occasional URL assembled by
  hand; the common paths get it wired in above. `undefined` when
  `config.baseURL` is unset, legitimate for an absolute-URL-only suite,
  not an error state.
- `resultOf(stepModule)`: the validated result of that step's most recent
  successful execution in the current scenario; `undefined` under `nuka
  do` or when the step hasn't succeeded yet. This is the scenario path's
  data channel, and it is deliberately not a World: nothing can be written
  to it, only results that passed their `returns` schema can be read from
  it, and the dependency is a visible `import` of the other step module,
  typed by that step's own schema, reviewable in the diff. A feature line
  like "that listing is closed" is implementable exactly to the extent its
  referent produced a validated result. `from` (see "Chaining steps") is
  the declarative form of the same read and the one to reach for first;
  `resultOf` is what remains for the reads a key name cannot express.
  Passing a `Step` that discovery never registered throws rather than
  returning `undefined`, see "Chaining steps" for the mistake that rule
  exists to catch.
- `await call(stepModule, args)`: runs one of this step's declared `parts`
  and returns its validated result (see "Parts"). The args are validated
  against that part's own `args` schema, the result against its
  `returns`, and the call is recorded under `calls` on this step's own
  step record. A step `parts` does not declare, or one discovery never
  registered, throws rather than running.
- `section(label: string): void`: marks that execution has reached a
  named stage; synchronous, no return value, no matching "end" call. Every
  call is appended, in call order, to the step record's `sections` (see
  "Records"); a step that never calls it gets no `sections` key at all,
  the same convention `used` follows. It is a bare marker rather than a
  function that wraps a block (`section(label, fn)`) on purpose: a
  wrapping form would have to decide what nesting, an early `return`, and
  an `await` crossing its boundary mean, and none of that is required to
  answer the question it exists for, where execution stopped, not how the
  block that stopped is shaped.
- `await poll(fn, { description, timeout, interval })`: the
  submit-poll-fetch loop for a state that has been asked for but is not
  there yet: `fn` returns `undefined` until it is, and its first defined
  value is what `poll` returns; the `timeout` budget running out first
  throws `PollTimeoutError` instead. Every completed call lands on the step
  record's `polls` (see "Records") with how many attempts it took, how long
  it waited, and
  how it ended. What `fn` polls for is a contract choice, not an
  implementation detail: it cannot be the observed target's own presence,
  because a target whose correct passing state is absence becomes
  indistinguishable, under that condition, from one that simply has not
  rendered yet (polling for presence makes it impossible for `fn` to ever
  return the answer the step is there to give). Poll instead for whatever
  makes a verdict about the target possible in the first place, a loading
  flag going false, a count leaving `undefined`, anything the page renders
  unconditionally once its data has arrived, and read the target itself
  only once that has resolved. A wait taken on the browser directly
  instead, through `page.waitForSelector` or `waitForLoadState`, waits the
  same way but leaves nothing behind: going through `poll` is what puts
  `at`, `attempts`, `waited_ms`, and `outcome` on the step record, which is
  the only way to tell "resolved on the first attempt, the wait did nothing"
  apart from "resolved four seconds in" after the fact. That is the same
  self-reported/measured line the Allure emitter already draws with its
  `declared:` prefix (see "Allure emitter"), drawn here between a wait
  the tool measured and one that happened invisibly inside Playwright.
- `evidence.attach(name, body)` / `evidence.path(name)`: the one gap the
  rest of this list never covered (every other fixture above hands back
  something the harness collects on its own). Nothing existed for
  application-specific evidence only a step can produce, an API response
  body, a DB snapshot, a generated file's contents. `attach` writes `body`
  (`string | Uint8Array`) into this execution's own evidence directory and
  records it on the step record's `evidence.attachments` (see "Records");
  calling it twice with the same `name` keeps both files, never overwriting
  the first. `path` is Playwright's own `testInfo.outputPath()`: it
  allocates a collision-free absolute path under that same directory
  without writing anything, and only a path a step actually wrote to by the
  time execution ends is listed on the step record (`path()` alone, with
  nothing ever written there, contributes nothing). Both methods sit on one
  object rather than two separate fixtures because both need exactly the
  same thing from the executor (which directory this step's own evidence
  lives in) and a step reaching for one is reaching for the other about as
  often. A `name` containing a path separator, or equal to `.`/`..`/the
  empty string, is refused outright, never silently rewritten: a step
  trusting a name it never actually asked for is worse than a loud error at
  the call that named it.

Where a wait belongs is a contract question, not a convenience one. A step
that writes to a system whose effect lands elsewhere asynchronously is not
finished when the write is accepted; it is finished when the effect is
visible to whatever the next step will look at, and the wait belongs
inside that step, the same rule as "a contract says what the step
demands", read forward instead of backward. Putting it in a later step
instead appears to work, because that step waits and the scenario passes,
but the wait is then attached to a path rather than to the operation that
needed it: another scenario reaching the same state by a route that skips
that step waits for nothing and fails. What surfaces is one scenario going
red while its siblings stay green, which reads like a property of that
scenario and is not one. A green scenario is no evidence that its waits
are placed correctly, every wait it needed could have been supplied by
coincidence, further down. Only a route that does not pass through them
can show where they actually belong.

`page` and `request` hand back Playwright's own `Page` and
`APIRequestContext` rather than types of nukadoko's own. That is a choice
with a cost, and it is stated as one (see "Out of scope").

`expect` is not a fixture. A step imports it directly, `import { expect }
from "playwright/test"`, and asserts with it exactly as a Playwright test
would. This follows from the same rule every other fixture answers to: a
fixture carries only what the executor must inject, and `expect` needs
nothing the executor owns (assertion evidence already reaches the step
record through the trace, `actions`, see "Records"), so making it a fixture would
add a member with nothing behind it but Playwright's own already-public
export.

`browser` is not a fixture either, and this one is a refusal, not an
omission. `context` is a fixture (the one `page` already belongs to,
nothing new to launch), so a step that needs a second tab reaches for it
via `context.newPage()`. `browser` itself would let a step call
`browser.newContext()` and mint a context the executor never sees:
unmeasured, untraced, outside every step record the run writes. Leaving the
name out of the bag is what keeps that path always unreachable, rather
than a convention a step has to remember not to break.

Two shapes are refused outright rather than silently mis-parsed: a
destructured fixture with a default value (`{ page = ... }`) and one
collected through a rest property (`{ ...rest }`). Both defeat the same
static reading this section opened with: a default value corrupts the
name `check` would otherwise read cleanly, and a rest property's own bound
names are not knowable without actually running the destructuring, which
`check` must not do. Neither loses anything a fixture legitimately needs:
a fixture is always present once it is named, so a default value has
nothing to default from, and every fixture a step needs can always be
named explicitly. `check` and `nuka run`/`nuka do` share one judgment for
all of this (the same "one judgment, two callers" shape "Chaining steps"
already uses for `from`), so a step never passes `check` and then fails
this refusal at run time, or the reverse. An unknown fixture name, a
default value, or a rest property refuses execution before it begins, the
same "never began" outcome an undefined step already gets, never a step
failure.

That reading is exposed outside `check` too: `nuka steps --json` reports
each typed step's own destructured names as `needs` (alphabetized, `[]`
when the step needs none) and `needs_browser` (whether `page` or `context`
is one of them). An agent picking a scenario can therefore see which ones
never open a browser at all before running any of them; a browser-using
scenario costs minutes and a real target that an API-only one does not.
`needs` is `null`, not `[]`, for the one `run()` this same static reading
cannot parse (a default value, a rest property, a bare identifier where a
destructuring pattern belongs); `needs_error` on that entry carries why,
and `needs_browser` is absent alongside it, since a browser-need verdict
this file cannot derive is not one it states. That step's own
name/patterns/description still come through: one unreadable `run()` does
not take the rest of the listing down with it. The call's own top level is
`{ steps, import_failures }`, not a bare array of steps; `import_failures`
(`{ file, message }`) names every step file whose own import failed, always
present, `[]` when nothing did (see "Tolerant reporting, fail-fast
execution" below).

For the one un-migrated shape among those, `run(ctx, args)`'s own bare,
un-destructured first argument, the same call also reports `needs_inferred`: a
lexical guess at that step's fixture needs, read by scanning `run`'s own
source text for that argument's member accesses (`ctx.page`) and filtered
down to known fixture names. It is a field of its own, never merged into
`needs`: `needs` is read from a destructuring pattern and is what the
executor actually builds before a step runs, while `needs_inferred` is a
guess about a step that cannot run yet, and folding the two together would
state something as certain that this reading cannot back. `needs_browser` is
never inferred alongside it, the same absence `needs: null` already gets
above. The scan is not exhaustive on purpose: it never follows an alias
(`const c = ctx; c.page()` goes unseen), so a reader must take it as a
starting inventory, not a finished one. It is present only when the throw
carried an identifier to scan by at all; a default-value or rest-property
throw leaves nothing to key a scan on, so `needs_inferred` is simply omitted
for those, exactly as it is for a step with no error to infer from in the
first place.

A local variable that happens to share a name with a fixture shadows it,
and only one shape of that mistake is caught before anything runs:
declared directly in `run`'s own top-level body, it collides with the
destructured parameter itself, and esbuild refuses to transform the file
at all (`The symbol "page" has already been declared`). Declared inside a
nested block instead, an `if`, a loop, a callback, the same collision
loads without complaint: `tsc` sees an ordinary local binding, typed
consistently on its own terms, and has nothing to flag, and `check` parses
only `run`'s first-argument pattern, never the body behind it, so it has
nothing to read there either. What surfaces is only the moment execution
reaches the shadowed name, and it does not reliably fail even then:
Playwright deliberately mirrors method names like
`click`/`fill`/`hover`/`screenshot` across `Page` and `Locator`, so a
`page` shadowed by a `Locator` goes on answering to the same calls the
step would have made against the real one, and can silently act on a
different element instead of throwing. Receiving the fixture through the
destructuring pattern's own alias syntax avoids the collision entirely:
`run({ page: pwPage, section }, args)` leaves `page` free to bind to
anything inside a nested scope, because there is nothing left for it to
collide with. This changes nothing about the contract: `fixtureParameterNames`
reads the name to the left of the colon, so `{ page: pwPage, section }` and
`{ page, section }` both read as `["page", "section"]`, and `needs`,
`needs_browser`, and fixture resolution all follow from that same list.
nukadoko does not detect the shadowing itself today; nothing above should
be read as a claim that it does.

### Fixtures

The bag "Context API" describes is closed: `page`, `context`, `request`,
`env`, `requireEnv`, `baseURL`, `resultOf`, `call`, `section`, `poll`,
`evidence`, nothing else.
A step that needs a project's own resource, a tenant, a seeded database, an
uploaded fixture file, has had nowhere to put the cleanup for it: writing it
into the step itself makes the feature file name something that is not an
acceptance condition, and skipping cleanup leaks it. `nukadoko.config.ts`
closes that gap:

```ts
export default defineConfig({
  fixtures: {
    tenant: async ({ request }, use) => {
      const t = await createTenant(request);
      await use(t);
      await destroyTenant(request, t);
    },
    seededDb: [async ({}, use) => { await use(await seedDb()); }, { scope: "process" }],
  },
});
```

A fixture is a bare function, or a `[function, options]` tuple: the same
two shapes Playwright's own fixture definitions take, so a fixture whose own
dependencies stay inside `page`/`context`/`request`/`baseURL` can be passed
to `base.extend()` unchanged. That shared subset is a fact about the shape,
not a promise this package makes: a fixture that destructures `env`,
`section`, `poll`, `resultOf`, `call`, `evidence`, or another nukadoko-only name means nothing
to Playwright's own runner, and `auto: true` (the option that would let
Playwright build a fixture nothing asked for) is refused outright, with a
message naming why: the feature file names everything that ran, and a
fixture nothing destructured is exactly the thing that principle forbids
building. "Accepts the same definition shape" is the whole of what this
package claims; it does not claim "Playwright fixture compatible" beyond
that shape, and putting one shared `fixtures.ts` behind both runners is not
the way to use this: TypeScript's own contextual typing only reaches an
inline object literal, so a fixture map factored out into a plain `export
const` loses it and fails to compile under `strict`. `defineFixtures`, from
the `nukadoko` package itself, is the fix for nukadoko's own half of that:
passing the exact same object literal through it keeps it inline from
TypeScript's point of view, so `request` and `use` both come out fully
typed with no annotation to write by hand. A fixture that depends on
*another* user-defined fixture still types that dependency as `unknown`,
since giving it the other fixture's own declared type would need the same
self-referencing inference this package deliberately does not implement
(measured to only work by an undocumented compiler quirk, not something
worth depending on).

A fixture's own first argument is destructured exactly like a step's own,
the same static reading "Context API" opened with, extended one layer:
`check` reads a fixture's own dependency names from its source text without
calling it, the same way it already reads a step's. Naming a builtin
(`page`, `context`, `request`, `env`, `requireEnv`, `baseURL`) as a
dependency works the ordinary way; naming *another* `config.fixtures` entry
resolves the same way Playwright's own `extend()` does: later layers can
depend on earlier ones, so a fixture is free to depend on another fixture,
which is free to depend on a builtin. Overriding a builtin is allowed the
same way: a `page` fixture wrapping the executor's own launch
(`page: async ({ page }, use) => { page.setDefaultTimeout(10_000); await
use(page); }`) reads `page` as the builtin underneath it, never as itself
(the one case where a same-named dependency is not a cycle). An override of
`page` that destructures neither `page` nor `context` has no way to hand
back a page the executor still owns and measures, so `check` refuses it
(`page-override-unowned`).

Two scopes exist: `scenario` (default) rebuilds per scenario, or per `nuka
do` execution, and tears down at that scenario's own end; `process` builds
once (the first time any step in the whole `nuka run` invocation names it,
directly or through another fixture) and tears down once, after every
scenario in that invocation has finished. `worker` does not exist:
nukadoko has no parallel execution yet, so a `worker` scope would be a
second name for exactly what `process` already means, spent before the
distinction between the two exists to be worth naming. Under `nuka do`, one
execution is the whole of both lifetimes, so the two scopes collapse: a
`process`-scope fixture behaves exactly like a `scenario`-scope one there. A
`process`-scope fixture may only depend on other `process`-scope fixtures
and on `env`/`requireEnv`/`baseURL`, the three builtins whose value never
depends on which scenario's context happens to read them; depending on
`page`, `context`, `request`, `resultOf`, `call`, `section`, `poll`, `evidence`, or a
`scenario`-scope fixture is refused (`fixture-scope-violation`), since a
`process`-scope fixture's own build can outlive the very scenario that
would have supplied any of those.

`process` names one address space, not one `nuka run` invocation: a
fixture's own value is a plain JS object and cannot cross into another
process, so this scope can only ever mean "once per process", no matter how
many times anything is invoked against it. Today one `nuka run` invocation
is one process, so the two happen to coincide, but that coincidence is not
a guarantee this scope makes. Something that has to happen exactly once in
the world, no matter how many processes ever run against it (seeding a
database, running a migration, starting a mock server that owns a port),
does not belong in a `process`-scope fixture: run more than one process
and it happens again.

Teardown runs in reverse build order, whether the step that named the
fixture passed or failed: a fixture's own cleanup code is not optional
just because the step it served already failed for its own reason. This
reversal is only correct because nukadoko builds and tears fixtures down
*serially*: folding teardown over the exact opposite of construction order
guarantees every dependency outlives its own dependents only as long as
nothing runs two fixtures' setup or teardown at once. The day nukadoko
parallelizes, this stops being true and breaks silently: a fixture's own
teardown reaching for a dependency another parallel scenario has already
torn down is exactly the kind of race `check` can never catch, because it
is a property of *when*, not of the fixture graph's own shape. Whoever adds
parallel execution has to come back to this reversal first.

A fixture's own outcome, whether the step (or, for `process` scope, the run
itself) that named it passed or failed, is not known at setup time, so it
is not a second argument to the fixture function: it is the *return value*
of `use()`:

```ts
tenant: async ({ request }, use) => {
  const t = await createTenant(request);
  const outcome = await use(t);          // "passed" | "failed"
  if (outcome === "passed") await destroyTenant(request, t);
},
```

"Keep a failed tenant around to inspect it, destroy a passed one" is
standard QA practice: Playwright's own `afterEach` reads `testInfo.status`
for the same reason. A teardown failure never changes the step's or
scenario's own status: a broken cleanup routine must not turn an otherwise-
green run red for a reason unrelated to its own acceptance criteria. It is
never silent either: it lands on the scenario record's `teardown_errors`
(a `scenario`-scope fixture's own failure) or on stderr (a `process`-scope
fixture's own failure, torn down once, after every scenario, with no single
scenario record of its own to carry it), and `nuka run`/`nuka do` announce
it either way; the exit code is unaffected.

A fixture must call `use(value)` exactly once. Forgetting to call it at all
is detected and thrown as soon as the fixture's own function settles
without having called it, naming the fixture; calling it twice is thrown
the same way, naming the fixture, the moment the second call happens. Both
close a hole `ctx.page()` never had before fixtures existed: a step's own
body calling (or not calling) a function was never something a caller
outside it had to wait on, where a fixture is a coroutine nukadoko itself
suspends at `use()` and resumes at teardown. A fixture that never reaches
that suspension point at all would otherwise hang the run forever. Setup
and teardown each get their own timeout budget, `config.fixtureTimeout`
(default 60 seconds), overridable per fixture via that fixture's own
`options.timeout`; whichever phase times out is reported by name, fixture
and phase both, since a hang with no name attached is worse than a failure
with one.

`check` reports three fixture-specific findings, all decided without ever
running a fixture: `fixture-cycle` (a dependency cycle among
`config.fixtures` entries), `fixture-scope-violation` (a `process`-scope
fixture depending on a `scenario`-scope one), and `page-override-unowned`
(above). `tend` adds two, both a fact rather than a verdict:
`fixture-unused` (a `config.fixtures` entry no typed step requires,
directly or through another fixture, still reachable through `nuka do`)
and `fixture-touches-app` (a fixture that reaches `page`/`context`,
directly or through another fixture). The second exists because a fixture
can let a scenario go green with a precondition the feature file never
named: logging a user in before any step asks for it is the same mistake
as a step doing work its own Given never described, one layer removed. It
is not a rule against fixtures touching the browser: generating
`storageState` is the standard, legitimate reason one does, and `tend`
never says otherwise. It only ever names which fixtures do, so a reader
decides whether a given one belongs on that list.

An execution's own step record carries `fixtures` (present only when non-
empty): every `config.fixtures` entry that execution's own bag resolution
actually touched, `{ "name", "scope", "setup_ms"?, "at"?, "reused" }`.
`setup_ms`/`at` are present only when this call actually built the
instance; their absence on a `reused: true` entry is what tells "already
built, hence fast" apart from "measured 0ms": without that distinction,
`setup_ms`'s own absence would be unreadable.

`nuka steps --json`'s `needs`/`needs_browser` (see "Context API") close
over the fixture graph the same way execution does: a step that only
destructures a fixture which itself reaches `page` still reads
`needs_browser: true`, even though the step's own `needs` array names only
the fixture, never `page` directly. There is nothing to close over for the
one step whose own `needs` came back `null` (see "Context API" for why);
that entry has no `needs_browser` either. It may still carry `needs_inferred`
(see "Context API"), but that field is a lexical guess, not a contract, and
is never closed over the fixture graph the way `needs`/`needs_browser` are.

### MCP servers

Two faces reach an ordinary MCP server over stdio, kept apart from `nuka
steps`: `nuka mcp-tools -- <command> [args...]` reads whatever tools a
server declares and prints them, and `connectMcpServer`/`callMcpTool`,
from `"nukadoko/mcp"`, let a hand-written step call one. A server's own
declared tools are material for a person writing a step's `args` by hand,
never something this package turns into a step, or its vocabulary, on its
own: `nuka steps` never lists an MCP tool, and nothing here generates one.

A server's process lifetime is a fixture's job, not a config key.
`nukadoko.config.ts` gets no MCP-specific field, because "Fixtures"
already covers everything a server's lifetime needs: setup, teardown, and
a `scenario` or `process` scope. A fixture calls `connectMcpServer` in its
own setup and `client.close()` in its own teardown, and picks whether that
happens once per scenario or once per run through the scope it already
has; running two servers at once is two fixtures, and nothing about the
mechanism itself changes.

`connectMcpServer` takes the client package's own stdio parameters and,
optionally, the client package's own `ClientOptions` as a second argument,
both unmodified, and returns the client package's own `Client`, connected,
the same "thin over official APIs" choice `ctx.page()`/`ctx.request()`
already make for Playwright. Which MCP protocol era a connection ends up
speaking is the client package's own `versionNegotiation` setting to
decide, itself one field of `ClientOptions`. Left out, the client
package's own default applies: the plain 2025 connect sequence, no probe,
no new headers. A caller that passes `{ versionNegotiation: { mode: 'auto'
} }` gets a `server/discover` probe first, with a conservative fallback to
that same 2025 sequence when the server does not answer as modern; on
stdio that probe costs one extra short-lived sibling process per connect,
spawned to run the probe and discarded once the era is known, so a fixture
that opts into `'auto'` pays for one extra spawn every time its own setup
calls `connectMcpServer`. A pinned mode (`{ mode: { pin: '<version>' } }`)
skips that fallback and fails loudly instead when the server does not
offer the exact pinned revision. `connectMcpServer` passes `ClientOptions`
straight through to `Client`'s own constructor, unread and never
overridden: choosing the era stays the caller's call, this face only
carries the choice. `callMcpTool` adds exactly one thing on top of a plain
pass-through: MCP itself returns a tool's own in-band failure as a normal,
successful response (`isError: true`), not a rejected promise, so a step
that never reads that field would record a failed call as a passing one.
`callMcpTool` throws in that one case and returns every other field of the
result untouched.

### WebMCP tools (experimental)

A third face reads declared tools without folding them into `nuka steps`,
the same separation "MCP servers" just drew for a stdio server, but over a
different protocol and through a different door. WebMCP is a browser
standard: a page declares its own tools through
`navigator.modelContext.registerTool`, in its own JavaScript, never over a
connection this project opens itself. `nuka experimental webmcp-tools <url>`
launches the configured browser fresh (no session restored, no evidence
collected), navigates to `url`, reads whatever that page has already
declared, and prints it as a report, never a vocabulary: `nuka steps` never
reads this surface and this surface never reads step discovery, because
letting a page's own declared tools become part of `nuka steps` would let
the page decide part of this project's own step vocabulary, the same
mistake this whole package exists to keep out of a generated
implementation. `experimental_callWebmcpTool`, exported from `"nukadoko"`
itself, is the half a hand-written typed step imports to call one of those
already-declared tools by name.

`experimental_callWebmcpTool` is a plain import, not a member of the
fixture bag "Fixtures" describes, for the boundary rule that section
already states: a fixture carries only what the executor must inject, and
the only thing this function needs from the executor is `page`, which
already reaches a step as a fixture on its own. `poll` crossed that same
boundary once, from an import onto the fixture bag, for a reason that does
not carry over here: a wait that finishes without being recorded cannot be
told apart, from a step record, from one that returned on its first try,
and that gap was worth closing by making it a fixture. Calling a WebMCP
tool has no such gap: the step around it declares its own `args`/`returns`
schemas, already validated at the run boundary regardless of how the value
inside them was produced (see "Context API"), so the step record already
carries whatever the call returned without this function needing to write
anything of its own.

Both halves carry the mark by name, never by a runtime flag: `experimental_`
on the function, prefixed rather than suffixed so it is still visible at
the point a step author's own autocomplete would offer it, and
`experimental` on the CLI, one command above `webmcp-tools` rather than
beside it. Either way the whole point is that a caller cannot reach the
surface without typing the word. That is also where this pair splits from
"MCP servers": `nuka mcp-tools` reports a similar kind of thing and stays a
top-level command, because MCP is the protocol this whole surface is named
after, not an auxiliary one; `nuka experimental webmcp-tools` is nested one
command deeper than every other command this package ships, on purpose, so
`experimental` is unavoidable at every call site that reaches it.

The mark is there because the standard's own documentation has not settled
whether this project's own use of it is even supported. Chrome's WebMCP
documentation (https://developer.chrome.com/docs/ai/webmcp), fetched
2026-08-13, states: "While it may be possible to run WebMCP tools in
headless environments, this API is primarily designed for local browser
workflows with a human in the loop," and separately that the whole standard
"is under active discussion and subject to change in the future." Its
Japanese localization, fetched the same day, goes further than the English
page does: translated, it says that because a tool call runs in
JavaScript, a browser tab or webview must stay open to provide it a
visible interface, so an agent or auxiliary tool calling a tool in a
headless state is unsupported. Calling a page's own tool from Node, through
Playwright, the way `experimental_callWebmcpTool` does, is exactly the kind
of caller either wording describes. That the two localizations disagreed on
this point, on the same day, is itself part of why the mark stays: a
standard whose own documentation is not settled about itself is not one to
build an unmarked dependency on. It measurably works against Chromium 149
today, this surface's own tests measure that much, but "measured" and
"guaranteed to keep working" are not the same claim.

The `experimental_` prefix, and the `experimental` subcommand, come off
only once both hold: the official documentation affirmatively supports
invocation by an auxiliary or headless caller, and it no longer describes
the standard itself as subject to change. A sentence simply going missing
does not satisfy either point on its own: the same disagreement between the
English and Japanese pages, on the same day, already shows that a missing
sentence does not settle which claim is current.

### Chaining steps

Giving a CLI-only step (one defined without a `pattern`) a `pattern` so it
binds into a scenario raises a question the step never faced standalone: how
does a value an earlier step produced reach this one? Two answers that look
obvious both give something up. Dropping the argument in favor of reading
everything through `resultOf` loses `nuka do`'s single-step execution
(there is nothing left to pass on the command line), and running standalone
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
  async run({ request }, args) {
    // args.projectId is present or this line was never reached.
    const res = await request.post(`/projects/${args.projectId}/archive`);
    return res.json();
  },
});
```

A pattern capture still wins: `from` supplies only the keys this occurrence
of the step did not capture, so the same step can take the value from the
Gherkin line in one scenario and from an earlier step in another. What it
takes is that earlier step's most recent successful result in this
scenario, the same lifetime `resultOf` has, because it is the same
chain. Injection happens before args validation, which is the point: the
key stays **required**, and `args` goes on describing what the step
demands instead of describing how one of its callers happens to supply it.

A key may name more than one possible producer. Some values are reachable
two ways (a project a scenario creates, or one it imports), and the
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
reader cannot see is one this tool declines to run, which is what makes
this safe to add. The question "which of these supplies the value" gets a
per-occurrence answer from the feature file, not a default from the step.

That is also why this is not settled the way repeats of a *single*
producer are. `Given a project is created` twice, then a consumer, reads
as the latest one, and that holds up: both occurrences carry the same
contract, so the later result supersedes the earlier and the question is
only freshness. Two *different* producers ask which contract the value
came from. Freshness has a defensible default; provenance does not.

Listing producers as alternatives says they are mutually exclusive: one
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
it, the consumer's own shape is what is wrong: it is asking for one thing
where the scenario has two.

Why a key name and not a selector function. A name is data: it survives
into `nuka steps --json` and `nuka describe` as "`projectId` ← `createProject.id`",
which is what lets an agent assemble an order it was never told, and it is
what `nuka check` reads to judge a scenario before anything runs. A
function would express more and say less: the tool could report which
step a key came from but never which part of it. A `returns` shaped flat
enough to be addressed by key is a mild cost, and steps read better that
way anyway.

Declaring `from` buys a check that costs nothing to be sure about. For
every occurrence of the step in every scenario, `nuka check` (and `nuka
run`, before it executes that scenario, so forgetting to check is not
punished with a browser session) asks whether each declared key is
captured by that line; if it is not, whether the upstream step appears
earlier in the same pickle (Background included, since a pickle carries
its Background steps). A **required** key with no producer bound
earlier is an error: that run would fail args validation with certainty,
so saying so early invents no false positive. An **optional** key with
none is silent: the schema already said the value may be absent, and
warning about a contract being honored would be noise in the one place
noise is fatal. Two or more of a key's listed producers bound earlier is
an error whether the key is required or optional: a schema gets to say
"this value may be absent", but no schema asked for "either of these two,
and the feature file cannot tell you which". This closes the case that
motivated `from`: a scenario that binds the consumer before the producer
used to be indistinguishable from a correct one until minutes of real
browser time had been spent.

`from` and `resultOf` both identify the upstream step by the `Step`
object itself, never by name, so a step reached through `await import()`
resolves to a different instance than the one discovery registered and
matches nothing. That used to be silent: `resultOf` simply kept returning
`undefined` forever. It is not silent now: an unregistered `Step` is an
error where it is found: `from` names one statically, so `nuka check`
reports it and `run`/`do` refuse to execute the step at all, while
`resultOf` can only be caught at the call, where it throws. A registered
step that has not run yet still returns `undefined`; that is a state, not
a mistake.

What `from` cannot express stays with `resultOf`: a value that needs
reshaping on the way, a read whose necessity is decided at run time, or a
whole result used as one. Reach for `resultOf` for those, and keep the argument optional
with a fallback inside `run` if the step must also run standalone (the
older shape, now the exception rather than the house style).

Under `nuka do` there is no scenario and therefore no chain, so a `from`
key arrives one of two ways: passed in `--args` like any other, or taken
from an earlier execution's step record with `--use` (see "Single steps"). A
step's contract does not change between the two paths; only where the
value comes from does.

One thing `from` deliberately does not do: run the upstream step for you.
A key whose producer is missing from the scenario is an error to fix in
the feature file, not a step for the tool to insert quietly: a feature
that does not name everything that ran would stop being the record this
whole tool exists to keep. The related pressure is real and has a
different answer: because a chained value has to come from a step, and a
step has to appear in the feature, a scenario can end up with a line that
exists only to move an id (`And the project's billing page is fetched`)
and means nothing to the reader the feature was written for. When an
operation has no value to that reader, it should not be a step at all.
Two places are left to put it, and "Parts" below draws the line between
them: an ordinary function under `features/steps/lib/` when there is
nothing to state a contract about, and a part when there is. Granularity
of the record against legibility of the feature is a judgment the step
author makes per case, and this is the axis to make it on.

Chaining is where declaration and measurement meet, and it meets
differently than `mutates` does (see "Keyword semantics"). There, the
measurement is a proxy (HTTP method standing in for write semantics), so
the tool records both and reconciles neither. Here there is no proxy:
which step record a value came from is exactly known. And because `from`
drives the execution rather than describing it, the declaration and what
happened cannot drift apart, so there is nothing to reconcile in the first
place. `used` on the step record (see "Records") is therefore not a check on
the declaration; it answers the question the declaration cannot: not
which step supplied the value, which was decided when the file was
written, but which *execution* of it did, which is only ever decided at
run time.

### Parts

A step is written at the granularity the scenario reads at, and that is
rarely the granularity anything else wants to reuse. Two shapes of the
mismatch appear as soon as a second scenario arrives. The step is right
but too concrete, and generalizing it means one more `args` key for the
pattern to capture, which the contract checks already cover. Or the step
does two things, the next scenario needs one of them, and there is
nothing to reach for: the half that is wanted has no name, no contract,
and no way to be called.

Splitting that step into two steps and rewriting the first scenario is
not the answer. That feature was agreed with the people who decide what
the software is for, and it may already carry a sign-off. A refactor on
the implementation side that rewrites an agreed sentence is the tool
arguing with the record it exists to keep.

A step may call another step instead. `parts` declares which ones, and
the `call` fixture runs one:

```ts
import { defineStep } from "nukadoko";
import { z } from "zod";
import createProject from "./parts/create-project.js";
import inviteMember from "./parts/invite-member.js";

export default defineStep({
  pattern: "a project named {string} has {string} as a member",
  description: "Create a project and invite one member into it",
  args: z.object({ name: z.string(), email: z.string() }),
  returns: z.object({ projectId: z.string(), memberId: z.string() }),
  parts: [createProject, inviteMember],
  async run({ call }, args) {
    const project = await call(createProject, { name: args.name });
    const member = await call(inviteMember, {
      projectId: project.id,
      email: args.email,
    });
    return { projectId: project.id, memberId: member.id };
  },
});
```

There is no second kind of unit here. A part is a `Step`, defined by the
same `defineStep`, and what makes it a part is that another step declares
it. A part written only to be called omits `pattern`, which is the
CLI-only vocabulary that already existed: `nuka do create-project` runs
it standalone and `nuka steps` lists it, so it is reachable and readable
before any scenario names it. Giving that same part a `pattern` later
binds it to a scenario line without taking it away from the step that
calls it. The split the second scenario needed leaves the first
scenario's feature file untouched, which is the whole point: the two
granularities coexist, and neither replaces the other.

Why `parts` is declared rather than read out of the body. A step's
fixture bag is built before `run()` is called, from the names its first
parameter destructures, read statically. A part destructures its own
names from that same bag, so a caller whose part reaches for `page` needs
`page` in the bag, and that decision is made before either function runs.
Finding out by reading `call` sites out of a body would be a parser
guessing at control flow, and the guess would be wrong in exactly the
case that matters, a call inside a branch. Declared, the answer is data:
a step's needs are its own names together with the names of everything it
declares, closed transitively, the same way a user-defined fixture's own
reach for `page` is already closed (see "Fixtures"). The cost of that is
paid where it can be seen: a composite whose part reaches for `page`
opens a browser even on a run that never takes the branch calling it. The
alternative costs more. A browser opening partway through a step, on a
decision no one could read before the step started, is the shape this
declaration exists to rule out.

The `from` section's argument holds here unchanged: a name is data.
`parts` survives into `nuka steps --json` and `nuka describe`, so an
agent reading the vocabulary sees that one step is built out of two
others without opening a file, and `nuka check` reads it before anything
runs. `call` refuses a step `parts` does not declare, and refuses one
discovery never registered, which is the mistake `resultOf` already
throws on: a step file reached through a second `await import()` produces
an object no vocabulary can match. A declaration nothing keeps honest
would be a comment.

A call is recorded inside the calling step's own step record, under
`calls`, and never as a step record of its own. A scenario record's
`steps[]` stays one entry per feature line. The feature goes on naming
everything that ran, and what a part adds is depth under one of those
lines rather than an entry the feature never asked for. Each entry
carries the part's name, the args it was given, the result it returned,
when it started and finished, and, when it failed, its own error under
the same classification a step record's `error` uses. A part's `args` and
`returns` are checked exactly like a step's, because they are a step's. A
part that calls a part nests the same way.

What does not split is everything measured at the step boundary.
`observed`, `sections`, `used`, `required_env`, the evidence directory,
and the trace chunk all stay the calling step's, and count the parts'
work inside their totals. A part shares its caller's `ctx`. This is one
execution described in more detail, not several executions sharing a
record. Reading one total is also what keeps the accounting honest:
nothing is counted twice, and nothing that ran goes uncounted because it
ran inside a part.

`from` is not consulted for a call. The caller passes every key itself,
the same way `nuka do` does, because a chain is a property of a scenario
and a call is not in one. A part that also runs as a scenario line keeps
its `from` for that occurrence. The declaration describes the step, and
which of its callers supplied what decides nothing about the others.

Two things `nuka check` can be certain of, so it says them. A cycle in
`parts`, a step that reaches itself, can never close into a fixture bag
or a terminating run, and is an error. A step that declares `mutates:
false` while declaring a part that declares `mutates: true` contradicts
itself, and is an error too: `mutates` says the step changes state
anywhere it touches, and a part it may call is somewhere it touches. That
check is what keeps `then-mutates` local. A `Then` line still reads one
flag on one step, because the contradiction check already forced that
flag to account for the parts.

A declared part the body never calls is reported by nothing, and that is
deliberate. The call sits inside `run`, while the declaration names a
`Step` object rather than the identifier that body happens to bind it
to, so deciding the two do not correspond would be a guess about a name. A body may also call a part on one branch
only. Either way the check would be wrong the first time it mattered,
which costs more than leaving the question unanswered. This is where the
symmetry with `from` stops: an unused `from` key is decidable from the
feature files alone (`nuka tend` reports it), and an unused part is not
decidable at all.

The read-only policy is not enforced through that contradiction check. A
read-only environment refuses a `mutates: true` part at the call itself,
before it runs, whatever its caller declared about itself. Of the two,
the contradiction check is the cheaper and the earlier, and it catches
the mistake while nothing is running; the refusal at the call is what
holds when nobody ran the check. A declaration is trusted here as
everywhere else, so a part that says it changes state is stopped where
the change would happen.

Helper, part, or step. The axis from "Chaining steps" gains a third
position rather than a second question. Does the operation mean something
to the person reading the scenario? If yes, it is a step, and the
acceptance record gains a step record for it. If no, ask what should be
knowable about it after a failure: a part when it has a contract worth
stating and inputs and a result worth reading back, an ordinary function
under `features/steps/lib/` when it has neither. A helper gives up its
own entry in the record; the HTTP it performs is still counted in the
calling step's `observed`, and `section` can still mark where execution
went. That stays a real option rather than a consolation. A function that
formats a payload or picks a fixture file has no contract anyone would
read and no result worth freezing, and making it a part would buy a
schema to maintain and nothing else.

One shape was rejected on the way. A step file could export several steps
as named exports, which would let the halves of a split sit beside the
composite that calls them. Typed step names complete from file names
without importing anything (see "Implementation notes"), which is what
keeps TAB fast however large the vocabulary grows, and a named export
cannot be seen without importing the file it is in. A part in its own
file keeps that property, and costs one file.

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
- **Statically**, `nuka check` warns (not errors) when a declared-
  mutating step is bound in Then position. The tension deserves human
  eyes; the declaration alone cannot settle it, and this check only warns.
- **Read-only environments refuse a declared-mutating step before it
  runs**, a part reached through `call` included (see "Parts"): the one
  place the declaration gates execution rather than drawing review's
  attention.
- **At run time**, the step record records what the execution actually did:
  every network call the tool saw (through the `request` fixture and the
  page alike), with non-GET/HEAD calls counted as observed writes, next to
  `mutates` (declared). That count settles nothing on its own anymore:
  not Then position, not a read-only environment's own policy. A declared
  `mutates: false` is trusted, whatever `observed` says.
- Gherkin classifies an `And`/`But` step by inheriting the pickle step type
  of the preceding primary keyword (Given/When/Then). That is gherkin's own
  pickle-compilation behavior, not a nukadoko choice, so an action chained
  after `Then` is recorded under Then-position observation the same as any
  other step there, not gated by it.
- Why measurement stopped settling this: write detection runs on HTTP
  method (non-GET/HEAD counts as a write), which is a proxy for write
  semantics, not the semantics itself. GraphQL, RPC-over-POST, and most
  vendors' query APIs implement a semantically pure read over POST; whether
  a call actually changed server state is the external system's own
  semantics, and nukadoko sits one layer below that, at HTTP. What would
  distinguish a read from a write is protocol-specific every time (a
  GraphQL body's `query` vs. `mutation`, an RPC body's method name, a
  vendor's own path convention), so no general mechanical judgment can
  stand in for the proxy. What the count guarantees is what a step sent,
  not whether the server's state changed; those are different facts, and
  treating the first as proof of the second overclaimed.
- Nothing about the record shrank: `observed`, http.jsonl, and the Allure
  declared/observed table stay exactly as measured, so a declaration that
  turns out wrong is still visible there: falsifiable after the fact.
  Accepting a falsifiable declaration is not measurement giving up; it is
  where the tool's authority over this particular fact actually ends.
- Falsifiable does not mean checked: nukadoko never runs that reconciliation
  itself, even though `mutates` and `observed` already sit on the same
  step record so an operator can compare them without a second artifact. No
  `nuka run` or `nuka check` output claims a mismatch between the two.
  Automating that claim would mean trusting the same HTTP-method proxy as
  settled fact (a GraphQL call, an RPC-over-POST call, or a vendor API that
  reads over POST would each read as a false positive, every time), which is
  the same reason run-time enforcement was dropped, above, applied here to
  reporting instead of execution. `nuka accept`'s own record is the one
  place this comparison is written out (see Sign-off): sign-off is the
  single moment a human already reads and judges a run, so stating the raw
  fact there costs nothing in false-positive noise the way stating it on
  every `nuka run`/`nuka check` invocation would.
- Compat (untyped) steps have no `mutates` to declare at all (see "What
  compat steps lack"): `nuka check`'s `then-compat-step` warning flags
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
  registration: a keyword means nothing at registration time; position in
  the scenario decides at run time, exactly as in Cucumber. Patterns are
  strings (plain cucumber-expressions: named captures are not required
  here; that discipline belongs to typed steps) or RegExp, since legacy
  glue is regex-heavy and the door must admit it. Both call shapes
  cucumber-js accepts are accepted (`Given(pattern, fn)` and
  `Given(pattern, { timeout }, fn)`, the timeout honored), and an
  unrecognized option key throws at registration rather than disappearing.
  Discovery imports the
  files and attributes each registration to the file that made it; a
  compat step's identity is its pattern text, `nuka steps` lists it with
  its kind, `nuka describe` shows the contract it doesn't have, and
  `nuka do` refuses it by name: promoting to `defineStep` is what buys
  single-step execution.
- `defineParameterType` from compat code registers into the same single
  registry as `config.parameterTypes`: moving a registration to config
  changes nothing about what any pattern matches, which is what makes the
  move safe to take early. `nuka check` lists support-origin registrations
  as warnings: config is where they retire to.
- Execution keeps the door's promise two ways: glue that launches its own
  Playwright keeps working, unmeasured, while `await this.openPage()` /
  `await this.openRequest()` hand out the harness's measured page and
  request, the same context a mixed scenario's typed steps share,
  cookies and all. Tables arrive as a thin, dependency-free `DataTable`
  (raw/rows/hashes/rowsHash/transpose), because `table.hashes()` glue
  must not break on an import switch; docstrings stay plain strings.
  Before/After hooks may be written any of the three ways cucumber-js
  accepts (`Before(fn)`, `Before({ tags }, fn)`, `Before("@tag", fn)`),
  receive cucumber's own hook parameter, filter on `@tag` / `not @tag`
  only (anything fancier fails loudly rather than mismatching silently),
  appear in the scenario record's `hooks` array rather than as their own
  step records, and their network traffic sits outside any step's boundary: http.jsonl
  and the observed read/write tally stay scenario-wide, never attributed to
  one hook invocation. The Playwright trace does not, though. Every
  individual Before/After/AfterStep call that touches `this.openPage()`
  gets its own trace chunk and `actions` list, on that same `hooks` array
  entry (`trace`/`actions`/`truncated`, the same shape a step's own record
  carries, see "Records"), isolated from every step's own chunk and from
  its sibling hooks'. A hook invocation still carries no `sections`/`polls`,
  since a hook has no fixture bag of its own to call `section`/`poll`
  from. Only `actions`, read back out of the chunk itself rather than from
  anything the hook explicitly called, is available to it. `AfterStep`
  shares that same registration surface (all three call shapes, the same
  `@tag` / `not @tag` filter), but where Before/After bracket the whole
  scenario, it runs once per pickle step that actually executed. A step
  this scenario skipped because an earlier one already failed never began,
  so there is no "after" for `AfterStep` to run at, and none appears for
  it, the same convention a tag-mismatched hook already follows. Each
  `AfterStep` entry in the `hooks` array carries `step_index`, the executed
  step's 0-based index into that record's own `steps` array, so a report
  can tell one entry from another; both the Allure and cucumber-messages
  emitters carry it through. The hook parameter's `result.status` reuses
  `@cucumber/messages`'s own `TestStepResultStatus` string values, and
  `nukadoko/compat` re-exports that same enum as `Status`, so glue written
  as `result.status === Status.FAILED` now imports and compares correctly.
  The enum's other members (`PENDING`/`SKIPPED`/`UNDEFINED`/`AMBIGUOUS`)
  can never match, because nukadoko has no pending, skipped, undefined-step,
  or ambiguous-match concept for a hook's own result to carry; a comparison
  against one of those is a branch migrated glue simply never takes, not a
  gap left open.
  `BeforeAll`/`AfterAll` bracket the whole run instead of a scenario (no
  tags, no World, skipped entirely when no scenario was selected) and
  report through the exit code, since a record is a scenario-shaped thing
  and these belong to no scenario. `setDefaultTimeout` supplies the default
  for anything that didn't declare its own; leaving it uncalled keeps steps
  unbounded rather than importing cucumber's five-second ceiling, which
  would fail slow suites for no reason but migrating.
- The World is measured, always: every compat step's step record records
  which World keys it read and wrote, in access order: the data flow
  `this.foo` used to hide. The measured surface is the bag's own data
  properties; `#private` state never appears there, by construction: a
  named boundary, not a bug. `defineWorld({ key: zodSchema })` opts
  individual keys into validation (a write that fails its schema fails
  the step and is never recorded as a write) and types `this` via
  `class MyWorld extends defineWorld({...})`. Cucumber's own
  `attach`/`log`/`link`/`parameters` are reserved: never measured, never
  declarable, and clobbering one is an error instead of a silent break.
- Because the harness owns the browser and request objects, compat steps
  already get measured step records (status, timing, trace, screenshots, HTTP
  log) with zero code change.
- What compat steps lack: typed contracts, a validated `result` in the
  step record, and single-step CLI execution. Promoting a hot step to
  `defineStep` is the upgrade, one step at a time.
- The door's width is measured, not asserted. Eight public cucumber-js
  suites were audited against it (their glue read as text, never run), and
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
  **`nuka check` can say it**: a step file whose import throws (a name
  `nukadoko/compat` doesn't export, used as a value; a CommonJS `require` in
  ESM glue; a deep subpath import) becomes a `step-file-import-failed`
  error, and a hook's tag expression beyond a single `@tag` / `not @tag`
  becomes `unsupported-hook-tag-expression`; both are known from the file's
  own text, before anything executes. Two more findings sit beside them,
  both about discovery's own walk rather than one file's content:
  `step-file-unsupported-extension`, when a `.cjs` file sits under
  `featuresDir` (see "Typed steps" above for why nukadoko never imports
  one), and `no-step-files-found`, when the walk found nothing at all to
  try. Each names exactly what it looked at, the same "so a reader can tell
  a finding isn't lying" reasoning `nuka tend`'s own `scanned:` line
  follows. **Only `nuka run` finds it**: a step
  or hook returning `"pending"` / `"skipped"`, and done-callback glue.
  These are properties of what happens when that step actually runs, not of
  how its file imports, so nothing before the step's own execution can name
  the fault. **Neither is a gap**: a name imported but used only as a type
  annotation, or imported and never referenced, is elided from the compiled
  output by esbuild before nukadoko ever imports the file, so that import
  never actually happens at run time: the glue runs exactly as written.
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
  results) are accepted rather than forbidden, but they must share one
  underlying mechanism, the split must be surfaced by `nuka check` instead
  of hidden, and every individual migration move must be
  semantics-preserving so it can be taken early and safely. The door
  swings both ways: switching the import back must remain possible.
- A step-by-step walkthrough of this door for an existing cucumber-js +
  Playwright suite lives in [docs/migration.md](migration.md). Moving a
  project already on nukadoko to a newer release is a different question,
  answered in [docs/upgrading.md](upgrading.md).

## The second door: a Playwright Test suite

The door above is for a suite built on cucumber-js, and it works by
swapping an import. A suite written directly against Playwright Test has
no import to swap: its tests are `test("...", async ({ page }) => {...})`
and there is no glue layer to redirect. That is not a smaller problem, it
is a different one, and it has a different answer.

A step-by-step walkthrough of this door lives in
[docs/migration-playwright-test.md](migration-playwright-test.md), the way
the first door's own lives in `docs/migration.md`. They are separate
documents because their readers do not overlap: nothing about compat, the
World, or hooks reaches somebody who never had cucumber.

**Share the implementation, not the runner.** An operation moves out of a
spec file into a plain async function that takes Playwright's own objects
and nothing else. The spec calls it. A typed step's `run` calls it too.
Neither runner ever loads the other's files.

```
e2e/cart.spec.ts  ──▶  features/steps/lib/cart.ts  ◀──  features/steps/add-item.ts
   (Playwright)              (plain functions)               (nukadoko)
```

The arrows point one way on purpose. The Playwright suite never imports
nukadoko, so what it depends on after the move is exactly what it
depended on before: Playwright, and a function in its own repository.
This door's way back is therefore stronger than the first one's. Reversing
the compat door means switching an import back; reversing this one means
deleting the feature files and the steps, after which the suite is
untouched because nothing it uses ever knew nukadoko existed.

What makes the sharing work is a shape rather than a promise: `page`,
`context`, `request` and `baseURL` are Playwright's own objects on both
sides (see "Context API"), so a function written against them is already
callable from both. Nothing is adapted, wrapped, or re-exported.

What is deliberately not shared is anything above that line. A spec must
not call `step.run(bag, args)` directly, which looks tempting and holds
only while the step destructures Playwright-only names: it breaks the
moment that step reaches for `call`, `section`, `resultOf` or
`requireEnv`, which is to say the moment the step becomes worth having.
And a fixture map cannot be shared either, for the typing reason
"Fixtures" already gives.

The contract can live in the shared unit rather than above it, and
should. A step's `args` and `returns` are plain zod schemas, so the
function's own file can export them and the step can declare them:

```ts
// features/steps/lib/cart.ts
export const openCartReturns = z.object({ id: z.string() });
export async function openCart(request: APIRequestContext) { ... }

// features/steps/open-cart.ts
export default defineStep({ returns: openCartReturns, run: ({ request }) => openCart(request) });
```

One definition, imported by both homes, so the spec and the step cannot
drift into disagreeing about the shape. The shared file still depends on
nothing but Playwright and zod, so the arrow above is unchanged.

The **record** is the other half, and sharing the implementation alone
does not produce one. A Playwright run leaves Playwright's own artifacts
and no step record, because a step record is written by an executor and
that home has none. An existing suite could therefore share every line of
its implementation and still leave nothing to harvest.

`experimental_recordStep` is the experiment that closes that, and it is
marked experimental by name for the reasons its own module gives.

```ts
const opened = await experimental_recordStep(
  openCartStep, { sku }, { name: "open-cart", rootDir, request },
);
const added = await experimental_recordStep(
  addItemStep, {}, { name: "add-item", rootDir, request, use: [opened.stepRecordId] },
);
```

**Pass the record id, never the value.** A spec naturally holds what the
last call returned in a variable and hands it to the next one, and doing
that here records no chain at all, because none happened: `use` is what
says one did, meaning exactly what `nuka do --use` means. Without it the
key reads as one the caller supplied, and `nuka harvest` writes that run's
own id into the draft, which then passes against a server that still
remembers it and fails against a fresh one. Threading the id instead
leaves the line alone and lets `from` fill it, the way it would have on
any `nuka run`.

The step runs against the spec's own `request`, its schemas are enforced,
and a step record lands where `nuka do`'s records land. So the suite a
team already runs becomes the source of records, and the journeys it
already encodes become drafts through `nuka harvest`: migrating by
running rather than by rewriting, which is a smaller ask than any
rewrite.

It takes a `page` as well as a `request`, deriving the context from
`page.context()`, which is what lets it reach a suite written around the
browser rather than only one written around HTTP. Evidence collection
attaches listeners to that context, and the context belongs to the
caller, so they come off again when the execution ends: leaving them on
would let one recorded step keep counting traffic from the rest of the
spec.

What an external record carries is therefore narrower than a `nuka run`
one, and narrower in a way that reads. There is no trace chunk, no
screenshot, and no `http.jsonl` line for page traffic, because Playwright
already produced its own artifacts for all three and a second copy would
say nothing new. What stays is what nukadoko alone measures: the args,
the validated result, `observed`, and the page events.

Three properties keep that from blurring what a record means. The record
says `kind: "external"`, a third answer to how an execution came about
alongside `do` and `run`, so it cannot be read as something a person
typed; `harvest` accepts it and goes on refusing a `run` record, which
already has a feature. The injected request context is wrapped for the
same logging and redaction any other one gets, and is never disposed,
since closing what another owner opened is a fault that only appears on
the second call. And a step whose fixtures reach for a browser is refused
before any record exists, so this path cannot half-work by quietly
launching one.

What still does not cross is the **sign-off**. `nuka accept` needs a green
full `nuka run` and its scenario record, and an external record is not
that. This tool's guarantee is about executions it drove itself, and one
it did not drive is one it can only take somebody's word for. So an
external record is a working record in exactly the sense a `do` record
is: the material a scenario gets harvested from, never the evidence.

Both of nukadoko's own paths open at once, which is the point of entering
here rather than rewriting. `nuka run` fixes a path in a feature file, and
`nuka do` runs any of those steps alone, so the same operations an
existing suite already trusts become the vocabulary an agent explores
with (see "Single steps" and "Live sessions").

Both trees can sit in one repository, and either arrangement works.
Side by side is the obvious one. The other is worth naming because it is
the smaller ask of a team whose Playwright suite is the asset: put
`featuresDir` *inside* the directory their specs already live in.

```
e2e/
  cart.spec.ts          <- Playwright finds this
  lib/cart.ts           <- shared, owned by neither runner
  nukadoko/             <- featuresDir
    cart.feature
    steps/add-item.ts   <- Playwright does not find this
```

That holds because each runner only loads what it recognises. Playwright
collects files matching its own `testMatch`, which a step file named for
the step it defines never does. Discovery imports every `.ts`/`.mts`/
`.js`/`.mjs` under `featuresDir`, which a spec kept outside it never is.
The two rules are about naming and placement, and they do not collide.

Two ways to get it wrong, both of which are caught rather than silent.

A spec **inside** `featuresDir` gets imported by discovery, and
Playwright's `test()` refuses to be called outside its own runner, so the
file fails to import. `nuka check` names it with Playwright's own message,
and `run`/`do` refuse to execute at all, exactly as they do for any other
broken glue.

A step file **named like a spec** collides differently. A step's name is
its file's basename, so `open-cart.spec.ts` defines a second step called
`open-cart.spec` carrying the same pattern as the first, and `nuka check`
reports `ambiguous-step` naming both. The pattern matching more than one
step is the error, and the fix is the file name.

The shared file belongs outside `featuresDir` in either arrangement.
Discovery would import it harmlessly, since a module defining no step is
simply not vocabulary, but the placement says who owns it, and the
existing suite does.

## Running

### Scenarios (the scripted path)

```sh
nuka run features/checkout.feature[:12] [--env <name>] [--session <name>] [--quiet]
```

`@cucumber/gherkin` compiles the file into pickles: flat, self-contained
scenarios with Background merged, Scenario Outline expanded, and tables
attached. nukadoko matches each pickle step against the committed patterns and
executes the steps in order. One step record per step; one scenario record
(feature path, scenario name, ordered step record ids, per-step status) per
pickle.

`nuka run` also takes a directory in place of a single feature file:
`nuka run features/` walks it recursively for every `.feature` file and
folds all of their pickles into the one invocation above, in file order,
one run_id, one summary, one exit code, one messages stream, one Allure
results tree. Files are visited in a fixed order, the repo-relative path
compared byte by byte rather than by locale, so which scenario ran in which
position stays stable across runs and a record or a report can be compared
against another one. `:line` on a directory is refused: it selects one
scenario inside a single file, and a directory names no single file for it
to select inside. A directory holding no `.feature` file anywhere under it
is refused too, the same tone `nuka check`'s own `no-step-files-found`
uses: it names exactly what it scanned, because a run that did nothing must
say so loudly rather than exit 0 having run nothing at all.

Every run writes to two channels for different readers. stdout stays NDJSON
only, one scenario record per line, meant for a script to parse, and nothing
else is ever written there. Everything meant for a person watching the run
lands on stderr instead: a boundary line before each pickle begins, one line
per step as it finishes, the paths this run actually wrote once it ends, and a
one-line summary. `--quiet` drops the two per-step and per-scenario progress
lines; the paths and the summary print either way, since naming where output
landed is never worth suppressing for a flag whose point is a quieter
terminal, not a silent one.

The paths line matters even when nothing was configured: `allure` and
`messages` output already exist with zero configuration, and their config
keys only relocate where each writes. A key sitting in a config file reads as
something switched on, not something already running by default, and that
misreading is exactly what printing every actual location, every time,
removes: a project can move its output without ever discovering it already
had some.

A scenario record's own `browser` field (`{ "type": "firefox", "version":
"133.0" }`) names the engine and version this particular run actually
launched, read from the real `Browser` object Playwright returns, never
from `config.browserType`. The two can disagree (a step can override the
`page` fixture with a browser this run's own `ctx` never launched), and only
the measured one is trustworthy enough to record. It is absent, not set to
some default, for a run whose pickle never launched a browser at all: a
pickle whose steps never destructure `page`/`context` opens none, and this
field never names a browser that never ran.

`:12` selects one scenario, which is the iteration path: a feature's full
run costs every scenario's minutes, and getting one of them right is
usually what the next few runs are about. It is not a smaller version of
the same thing: a partial run can never be signed off (see "Sign-off"), so
a green one is a debugging result and nothing else. `nuka run` says so
where the line number is given, rather than leaving it for `nuka accept`
to reveal several runs later, once the road has already been taken.

Steps in one pickle share one context (the World semantics Cucumber users
expect): a Background that logs in hands its browser and cookies to every
later step. A failed step skips the rest of the scenario, and skipped steps
get no step record (an execution that never began must not be citable; the
scenario record is what says "skipped"). Evidence follows its natural scope:
each step's record carries that step's own http.jsonl and its own
Playwright trace alike. The trace used to span the whole shared context and
live in the scenario's own directory instead, one file, opened once at the
first step whose bag named `page` and closed once at the end. It is cut at
every step boundary now, the same laziness a step's own fixture bag
already has: a step that never destructures `page` gets no trace chunk at
all, and a step that does gets one holding only what it did. Opening the
trace for the step that actually failed is faster than scrubbing through a
whole scenario's recording for the moment things went wrong, and that is
the entire reason for the change. What a single scenario-long trace also
gave for free, a network view spanning every step at once, a step-scoped
trace does not: each step's own trace still shows that step's own
requests, so nothing about a single step's traffic is lost, only the
ability to browse every request the whole scenario made without opening
more than one file. `request` fixture traffic and the page's own traffic
now share that same step-scoped view
instead: both land on the same http.jsonl, each entry marked `via:
"request"` or `via: "page"` so a reader never has to guess which path a
call took. Only a page's `document`/XHR/`fetch` requests are recorded that
way (a single page load can pull in dozens of images, a stylesheet, and a
script bundle, and a file trying to hold all of that would stop being
something a reader opens), but nothing about the drop is silent: what got
left out lands on the step record itself, by resource type, as `http_omitted`
(see "Records"). `observed` is untouched by any of this: it keeps counting
every request the page makes, image and script traffic included, because it
answers a different question than http.jsonl does, and the two counts are
not expected to match.

Before a pickle runs, its steps' `from` declarations are checked against
its own step order: a required chained key whose producer is absent or
bound later fails that scenario before anything launches, since executing
it could only end in the same failure minutes later (see "Chaining
steps"). Other scenarios in the file still run: this is one scenario's
property, not the file's.

An undefined step fails the scenario naming the text that failed to match
and suggests `nuka scaffold`. An agent following the bundled skill authors
the missing typed step and submits it as a PR: the feature backlog drives
vocabulary growth.

### Single steps (the agent path)

```sh
nuka do create-project --args '{"name":"acme"}' [--env <name>] [--session <name>]
nuka do archive-project --use step-20260801-143022-a1b2
```

Executes one typed step and prints its step record to stdout (exit 0 on ok, 1 on
failed). This is the adaptive loop: the agent reads the validated result and
decides the next call. The agent can only choose which step to call with
which args; it cannot choose what gets recorded. There is deliberately no
grouping label on `do`: ad-hoc sequences are working records, not evidence.
Anything worth attesting to is expressed as a scenario and proven by
`nuka run` (see Self-healing).

`--use <step-record-id>` (repeatable) supplies the step's `from` keys from an
earlier execution instead of the chain a scenario would have provided (see
"Chaining steps"). The upstream step's name is not written on the command
line because the step record already carries it: nukadoko reads which step
that record belongs to, finds the `from` entries pointing at it, and takes
the named keys out of its stored `result`. A step record for a step this
one does not declare a `from` on is an error rather than a silent no-op, as
is a step record whose execution failed: a failed step never produced a
validated result to read. `--args` still wins over `--use` for the same
key, the same way a pattern capture wins inside a scenario. The record ids
actually drawn from land in this execution's own `used`, so a chain
assembled by hand across several `do` calls is as traceable afterwards as
one a scenario drove.

What crosses with `--use` is the value itself, not a guarantee that
whatever it names is still there: a path an upstream step returned can
point at a resource a fixture owns, and that fixture may already have torn
down by the time a later `--use` call reads the path back, since one
execution is the whole of a fixture's scope under `do` (see "Fixtures").
Whether a returned value names something a fixture will tear down is not
visible from the schema or from the step's own code, so this is not a
mistake `check` can catch before the run does.

A step that passes under `do` has not thereby been shown to pass under
`run`. `do` gives every execution its own browser and its own everything
else; a scenario gives one context to all of its steps, so the second one
meets whatever the first left behind (already signed in, on a different
page, a dialog still open). The two questions are different and neither
answer substitutes for the other: `do` asks whether the step works, `run`
asks whether it works there. `--session` narrows the gap by carrying
storageState across `do` calls, which covers login state and nothing else;
where execution had got to is not in it. This lands hardest on a step
whose own setup is a no-op the second time it runs, and the fix is in the
feature rather than in the engine: establish the state once, in the step
whose name says it does, instead of once per step.

### Live sessions (exploring from where you got to)

Everything above starts from nothing. `nuka do` gives each execution its
own browser and its own everything else, which is what makes one call
readable on its own, and what makes exploring expensive: the twentieth
thing you want to try has nineteen things in front of it. For reads that
is only slow. For work that cannot be repeated, an account that opens
once or an invoice that would be issued twice, it is not possible at all.

A **live session** is one `ctx` held open by a process, so executions can
land on it one after another instead of each building a world from
scratch.

```sh
nuka session start alice
nuka do open-cart --session alice
nuka do add-item --session alice --args '{"sku":"S-1"}'
nuka session stop alice
```

What persists is the whole context, not the browser. Persisting only the
browser would leave a world that is half old: a user fixture rebuilt for
this execution sitting next to a page five executions deep, with nothing
saying which parts are which. Holding the entire fixture bag open removes
the question, because nothing is rebuilt underneath anything.

That is not a new lifetime. A scenario already builds one `ctx`, runs
several steps against it, and tears it down; a live session is the same
lifetime with the list of steps arriving one at a time instead of from a
feature file. The two fixture scopes need no third value: `scenario`
scope lasts the session, and `process` scope lasts the session's process
(see "Fixtures").

**The lock file is the rendezvous, and it already exists.** A session's
`cache/sessions/<env>/<name>.lock` holds `{ pid, started_at }` and is
checked against `process.kill(pid, 0)` today, with a dead pid's lock
already defined as stale and free to take over. `nuka do --session alice`
finds a live pid there and hands its execution to that process; finds
none and behaves exactly as it does now. Nothing new has to be
discovered, and the rule that a dead owner's claim is worth nothing is
already the one in force.

Stopping a session writes its storageState to the same
`cache/sessions/<env>/<name>.json` a session has always left behind. So a
session has two lifetimes rather than two meanings: it is a process while
it lives, and the state it saved once it does not.

**A record from a live session must not read like a record from a clean
one.** A step that passed as the thirtieth execution against a world
nobody else can rebuild has proved something different from the same step
passing on its own, and a green record that cannot be told apart from the
other kind is the one way this feature could quietly damage every record
around it. `session` is already on a step record; what a live session adds
is that it was live and where in the sequence this execution fell.

One execution at a time per session. The lock already means "someone owns
this right now", so a second `do` against a busy session is refused rather
than queued: an exploration is driven by something deciding the next call
from the last result, and two callers deciding at once is not that.

Nothing here can become evidence, and no new fence is needed to keep it
that way. A live session produces step records and no scenario record, and
`nuka accept` refuses without a green full run (see "Sign-off"), so the
path from an exploration to a sign-off runs through `nuka harvest` and a
real `nuka run` or it does not exist.

`nuka run` and `nuka accept` report a live session when they find one,
naming it and how to stop it, and refuse nothing on its account. The fact
worth surfacing is that the application may be holding state an
exploration put there, which is exactly the kind of thing that makes a
scenario pass for a reason nobody wrote down. Whether that session has
anything to do with the feature being accepted is not knowable from here,
so this is reported as a fact and never as a verdict.

The socket a live session listens on holds the same live credentials the
storageState file does, and is created with the same restricted
permissions for the same reason (see "The state directory"). An idle
timeout applies by default, because a forgotten session is the normal
outcome of an interrupted exploration rather than an unusual one, and
`nuka session list` reaps the ones whose pid is gone.

The honest limit is the point of the feature rather than a flaw in it: a
world thirty executions deep is not reproducible, by anyone, including
the process holding it. That is why what comes out of an exploration is a
draft to be harvested and run again from nothing, not the run itself.

## Records

A step record is the tool's own measurement of one step execution: the same
shape whether the step ran inside a scenario or via `do`. A scenario record
(see "Running") answers the same question one grain up: what a pickle's own
run actually did, over its ordered steps rather than over one execution
alone. The two are one concept read at two resolutions, not two different
ones: a scenario record's own `steps` array names each step's record by id,
so a reader can open either first and reach the other from it.

```json
{
  "step_record_id": "step-20260801-143022-a1b2",
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
  "scenario_record_id": null,
  "run_id": null,
  "started_at": "...",
  "finished_at": "...",
  "evidence": {
    "dir": ".nukadoko/records/steps/step-20260801-143022-a1b2",
    "trace": "trace.zip",
    "screenshots": [{ "file": "final.png", "at": "..." }],
    "http": "http.jsonl"
  }
}
```

- `result` is the trust anchor: it passed the returns schema and the tool
  (not the caller) produced it. On failure, `error: { kind, message }`
  replaces it. Compat steps record `result: null`.
- `scenario_record_id` and `run_id` name what this execution belongs to:
  the owning scenario record's id and the `nuka run` invocation's own id
  for a `run`-originated step (`kind: "run"`), both `null` for a
  `do`-originated one, which belongs to neither. Without `run_id`, telling
  which run one step record came from meant opening the scenario record
  beside it first; a step record answers that on its own now, the same way
  it already answers everything else about what this one execution did.
- `error.kind` is a closed set, beside the message a human reads:
  `args_invalid`, `result_invalid`, `binding_invalid`, `world_invalid`,
  `timeout`, `unsupported`, `step_error`. Closed because a report has to
  classify against it: an open one, extended per step, would classify
  nothing. The first four name failures that exist only because there is a
  contract to violate, which is the part a report built on a runner that
  discards return values cannot fill in; a classifier that isn't sure says
  `step_error`, since claiming a contract failure wrongly is worse than not
  claiming one. Hook records in the scenario record carry the same field.
- `mutates` is the step's own declaration (`null` for a compat step, which
  has none to record, not `false`), sitting beside the `observed` counts
  so declared and measured can be compared without a second artifact.
- Evidence is collected by the harness, never reported by the step: Playwright
  tracing and screenshots when the browser is used, every `request` fixture
  call and the page's own document/XHR/fetch traffic alike logged to
  http.jsonl, the step record itself as the primary one.
- `evidence.screenshots` is at most one entry, `{ "file": "final.png", "at":
  "..." }`: a browser-using execution's evidence used to be two files, the
  same buffer saved under a second name whenever the step failed. That cost
  nothing to write but implied something the tool never measured: that a
  "failure" screenshot exists as a distinct fact from the last one taken. It
  never was: the screenshot only ever runs once, after `run` has already
  returned or thrown, so that second copy could already be stale relative to
  the failure it was named for. `at` (ISO 8601, the same format
  `started_at`/`finished_at` use) is what the second file was standing in
  for without ever stating it, and it says the real thing: how long after
  this execution's own timeline the screenshot was actually taken.
- `observed` counts the network calls the tool itself saw the execution
  make, through the `request` fixture and the page alike; non-GET/HEAD counts as
  a write (HTTP method as a proxy for write semantics, not semantics
  itself), so a POST-based read counts against a step that never wrote
  anything (see Keyword semantics). It settles nothing on its own: Then
  position and read-only environments act on the `mutates` declaration,
  never on this count. `observed` sits beside `mutates` (declared) so a
  wrong declaration is falsifiable, here and in the Allure report.
- `evidence.http` (present only when at least one call was logged) points at
  http.jsonl, one JSON object per line: `{ "method", "url", "status",
  "duration_ms", "via" }`. `via` is `"request"` for a call made through the
  `request` fixture, and `"page"` for one the page itself made (a `page`
  navigation, or an in-page `fetch`/XHR), present on every entry either path
  produces, so a reader never has to guess which one wrote a line from its
  shape alone. Only `document`, `xhr`, and `fetch` requests (Playwright's own
  `request.resourceType()`) ever reach http.jsonl for page traffic; a real
  page load can pull in dozens of images, stylesheets, and scripts that
  nobody reading a step record for acceptance purposes traces one by one,
  and a file trying to hold all of them would stop being something a reader
  opens at all.
- `evidence.attachments` (present only when non-empty) lists what
  `evidence.attach`/`evidence.path` actually wrote this execution (see
  "Context API"), each `{ "name", "file", "at" }`: `name` is what the step
  asked for, `file` is what actually landed on disk under `evidence.dir`,
  and the two differ only when the same `name` was used more than once this
  execution. The second use gets `-2`, `-3`, ... inserted before the
  extension rather than overwriting the first (`dup.txt` then `dup-2.txt`,
  never one `dup.txt` silently replaced by the other). `at` is taken by the
  harness itself, never supplied by the step: for `attach`, the moment the
  write resolved; for a `path()`-allocated file, that file's own mtime once
  execution confirmed it exists, the same measured-not-declared rule
  `sections`/`polls`/`evidence.screenshots[].at` already follow, landing
  attachments on that same absolute timeline. A `path()` call with nothing
  ever written to the path it returned contributes no entry at all: only a
  file confirmed to exist on disk is ever listed, the same "evidence lists
  only files that exist" rule `evidence.http`/`evidence.trace` already
  follow. Whether a `path()`-allocated file was actually written is
  decided by the harness checking, never by the fixture bookkeeping the
  call. A `name` containing a path separator, or equal to `.`/`..`/the
  empty string, is refused before anything is written, never silently
  rewritten into something safe. Capped at 100 entries, sorted by `at`, the
  same convention `page_events`/`actions` already use; the true total, once
  that cap is hit, lands on `truncated.evidence` (below), the same sibling
  field `truncated.actions` already uses. The step record's `name`/`file`
  strings pass through the same single redaction pass every other field
  does; the attachment's own file *contents* are never redacted (redacting
  arbitrary bytes would as often corrupt them as protect them). What
  `attach` is given is the step's own responsibility to keep secret-free.
- `http_omitted` (present only when at least one page-issued request was
  left out) is what keeps that drop from being silent: the count of what
  didn't make it into http.jsonl, by resource type, e.g.
  `{ "image": 34, "stylesheet": 5, "script": 12 }`. `observed` (above) is not
  narrowed by any of this: it tallies every request the harness saw, image
  and script traffic included, because it answers a different question (how
  many reads and writes actually happened) than http.jsonl does (which of
  those calls are worth reading one by one). The two counts are not
  expected to add up to each other, and neither being lower than the other
  is a bug.
- `used` (present only when non-empty) lists the earlier executions whose
  results this one drew a value from: through a `from` injection, a
  `resultOf` call, or a `--use` step record on `nuka do`. Every path runs
  through library code, so the reads are measured, not declared. Each entry
  is `{ "step_record_id": "step-…", "step": "create-project" }`: the step
  name is redundant with the cited step record and is written down anyway,
  because a record that has to be resolved against other files to be read
  is worse for a reader than one that is legible alone, and the file it
  would be resolved against is a local working record that a sign-off (see
  Sign-off) long outlives. Entries are deduplicated by record id, in the
  order first read. The dependency is thus visible twice over: statically
  as `from` or an import, at run time as provenance in the step record
  chain. Which upstream *step* a value came from was settled when the step
  file was written; which *execution* of it supplied the value is knowable
  only here.
- On a **failed** step's record only, each `used` entry additionally
  carries `result`: the upstream step record's full validated result,
  sitting right beside the id/step pointer. This is what lets one failed
  step record be read alone instead of opening a second `record.json` just
  to see what the step actually saw. An `ok` step's `used` entries never
  carry `result`: the value that mattered is already sitting on that
  step's own `result` (or on its `args`, if it came in through `from`), so
  repeating the upstream one there would only be redundant. The whole
  result, not narrowed to the one key a `from` injection or `resultOf` call
  happened to read: diagnosing a failure needs *why* the upstream value
  came out this way, not which key was cited: narrowing to the cited key
  would recreate, on the step record side, the same citation-only trap
  "return more than what a later step cites" (see Typed steps) already
  warns against. That also means this field can only carry what the
  upstream step's own `returns` schema kept in the first place: a
  `returns` that dropped a value drops it from here too.
- `calls` (present only when non-empty) lists the parts this execution ran
  through the `call` fixture (see "Parts"), in call order. Each entry is
  `{ "step": "create-project", "args": {...}, "result": {...},
  "started_at": "...", "finished_at": "..." }`, and carries `error`
  instead of `result` when the part failed, classified the same way a step
  record's own `error` is. A part that called a part carries its own
  `calls` under that entry. These are not step records and have no
  `step_record_id`: `--use` cites a step record, and what this execution
  offers a later one is its own `result`. Recording the args and the
  result at each internal boundary is what a composite step's record is
  read for once it fails, since the values that crossed those boundaries
  are otherwise nowhere.
- `sections` (present only when non-empty) lists the `section` calls
  made during this execution, each `{ "label": "...", "at": "..." }`, in
  call order. Not deduplicated, unlike `used`: a label entered twice (a
  loop, a retry) was entered twice, and the array should read that way,
  where `used` names a step record id once because an id is an identity
  worth citing once, not a point in a sequence. `at` was left off at first,
  on the reasoning that the question `sections` answers is where execution
  stopped, not where it was slow. That turned out to be only half true. A
  label alone says a stage was reached, never *when* relative to anything
  else this same record carries, and a real run surfaced exactly the gap
  that leaves: a `status: "failed"` sitting next to a `final.png` that
  showed the target still present, roughly eight seconds apart, with
  nothing on the record saying so: read at face value, that looks like
  the state was flickering, and it was misdiagnosed as exactly that. `at`
  (ISO 8601, taken by the collector itself when `section` is called,
  never supplied by the step) puts every label on the same absolute
  timeline `started_at`/`finished_at`, `polls`' own `at`, and
  `evidence.screenshots[].at` already share, so "did the state actually
  change" and "was this read taken before it settled" stop being
  indistinguishable from a step record alone. A failed step's `sections` still
  holds whichever labels it reached before the failure, and that array's
  last element already answers "which stage was it in": there is no
  separate `error.section` field putting the same fact in a second place.
  Only a typed step's fixture bag has `section`; a compat step has no
  counterpart on `this`, so `sections` is simply omitted for one, the same
  way `used` is omitted for a typed step that never read from the chain.
- `polls` (present only when non-empty) records every `poll` call that
  finished during this execution: its `description` when one was given,
  `at` (the ISO 8601 moment that call began), how many times the
  predicate ran, the milliseconds elapsed, and how it ended: `resolved`,
  `timed_out`, or `failed` when the predicate itself threw. In completion
  order rather than call order: a nested poll finishes before the one
  containing it, and only a finished poll has counts to state. A timed-out
  poll is recorded like any other, since that step's own record is exactly
  where the numbers are wanted. Unlike
  `sections`, `polls` always carried timing beyond a bare label, because
  the question it exists for is a timing question: one attempt at 0ms says
  the condition was already true and the wait was a no-op, forty attempts
  over 20s says it was genuinely late, and the two look identical from
  outside the step while calling for opposite fixes. `at` adds the missing
  half (an absolute start, not just a duration), so a poll can be placed on
  the same timeline `sections` and `evidence.screenshots` now share, instead
  of read as a length with no fixed point to measure from. A compat step has
  no fixture bag to call it on, so `polls` is simply omitted for one, the
  same way `sections` is.
- `required_env` (present only when non-empty) lists the names
  `requireEnv` was called with during this execution, deduplicated, in
  the order first read: the same measured-not-declared shape `used` and
  `sections` already have, since `requireEnv` is the one call site the
  library controls. Recorded before a missing key throws, so a
  `MissingEnvError` failure's record still shows what the step asked for.
  Only names are recorded, never values: a value can be a secret. A step
  that reads `env[name]` directly leaves no trace here: this field
  counts only what passed through `requireEnv`, never a plain object read
  the library never sees.
- `page_events` (present only when at least one category is non-empty)
  records what the browser context itself saw while a step ran: console
  errors (`console.error` calls only, never warnings, which most SPAs emit
  routinely enough to be noise), uncaught page errors (`BrowserContext`'s
  `weberror`, the context-level counterpart to `Page`'s `pageerror`), and
  requests that failed at the network level. Service workers stay outside
  what the browser context sees: `BrowserContext`'s events cover pages in
  the context, not a worker, and Playwright's `Worker` type exposes only
  `close` and `console`, no request or error event to listen for, so what
  a service worker's console emits and any background fetch failure inside
  it go unrecorded. cucumber-js has no browser context of its own to hold
  any of this: a step can pass (`status: "ok"`)
  while the page underneath it was throwing the whole time, and before this
  field nothing on the record said so. Each category is present only when
  it recorded at least one entry, and is always a bare array, never
  something whose own type depends on how many entries it holds:
  `console_errors`, each entry `{ "text", "location": { "url", "lineNumber",
  "columnNumber" }, "at" }`; `page_errors`, each entry `{ "message", "at" }`
  (never the error's own stack: trace.zip already carries it, and a stack
  widens what redaction has to reach for little gain); `failed_requests`,
  each entry `{ "method", "url", "failure", "at" }`. `at` (ISO 8601) is
  taken by the collector itself, the same measured, never declared
  convention `sections`/`polls` already follow. Capped at 100 entries per
  category: a redirect loop or a chatty page can produce thousands of these
  in one step, and a step record trying to hold all of them would stop
  being something a reader can open. A category that hits the cap stays a bare
  array (still capped at 100) and instead adds its own name to a sibling
  `truncated` object on `page_events`, mapped to its true total, present
  only when at least one category was actually truncated:
  `"truncated": { "console_errors": 4213 }`. An earlier version reported
  the same fact by turning a truncated category itself into
  `{ entries, total, truncated: true }`, so a category's type changed with
  how many entries it held and a reader had to branch on that type before
  trusting a count read off it; the sibling field exists so every category
  is always the same shape and a truncation is a separate fact, reported
  once, in one place. Redacted the same way every other field is: a secret
  can land in console text or a failed request's URL as easily as it can
  anywhere else, so no separate redaction path exists for this field.
  Present on both a successful and a failed step's record alike: a page
  error is evidence about the page, not a verdict on the step.
- `actions` (present only when non-empty) is read out of this step's own
  trace chunk (`evidence.trace`, above): every Playwright call the step made
  through the `page` fixture, `expect` waits included, in the order the
  trace recorded them finishing. `expect` is deliberately not a fixture
  either (see "Context API"): a step reaches it the same way a Playwright
  test file would (`import { expect } from "playwright/test"`), and the
  trace records the call underneath that wrapper, at Playwright's own
  layer, the same place `goto`, `click`, and every other call already
  lands. Each entry
  is `{ "method", "expression"?, "selector"?, "url"?, "is_not"?,
  "timeout_ms"?, "ms", "outcome", "at" }`: `method` and the five optional
  fields are copied straight off the trace's own call, `ms` is that call's
  own duration on the trace's own clock, `outcome` is `"failed"` when the
  trace recorded an error on it and `"passed"` otherwise, and `at` (ISO
  8601) is converted from the trace's own monotonic clock into an absolute
  timestamp, landing `actions` on the same timeline `sections`/`polls`/
  `evidence.screenshots[].at` already share. The five optional fields are an
  allowlist, not everything the call carried: a `setContent` call's own HTML
  body, for one, can run to kilobytes, and nothing a step record is for
  needs it when trace.zip already has the whole thing. Capped at 100 entries, same
  convention as `page_events`, with the same sibling `truncated` field
  reporting the true total when the cap is hit: `"truncated": { "actions":
  214 }`. `evidence.attachments`' own truncation (above) reports through
  the same field too, as `truncated.evidence`, present alongside
  `truncated.actions` whenever both caps were hit in the same execution,
  either alone when only one was. Redacted the same single pass every other field is: a secret can
  land in a `url` or `selector` as easily as it can anywhere else, so no
  separate redaction path exists for this field either. A trace chunk that
  cannot be read at all (corrupt, or simply never opened because the step
  never destructured `page`) costs `actions` silently, the same
  measurement-must-never-break-execution rule every other evidence-reading
  field on this list already follows. The one loud exception is a trace
  format version this build does not recognize: guessing at an unverified
  shape is worse than reporting nothing, so `actions` is still omitted, but
  `nuka run`/`nuka do` also warn once, on stderr (`warning: trace format
  version <n> is not readable by this build; step actions were not
  recorded`), because a silently empty `actions` sitting next to a
  `evidence.trace` that plainly exists would otherwise read as "nothing
  happened" rather than "this build could not read it".
- A Before/After/AfterStep hook has no step record of its own (see "Compat
  steps"), so its own trace evidence lands on that invocation's own entry in
  the scenario record's `hooks` array instead: `trace` (relative to the
  scenario's own directory, not a step record dir, since a hook has none),
  `actions`, and `truncated`, in exactly the shape above, present under
  exactly the same rules. A hook invocation carries no `sections`/`polls`
  alongside them: both come from a typed step's `section`/`poll` fixtures,
  and a hook has no fixture bag of its own to call either from, only a
  World (`this`). `actions`, read back out of the trace chunk itself
  rather than from anything the hook explicitly called, is unaffected by
  that gap. A hook invocation that never touched the browser opens no
  chunk and carries none of the three fields at all, the same as a step
  that never destructured `page`.
- `fixtures` (present only when non-empty) lists every `config.fixtures`
  entry this step's own bag resolution actually touched, `{ "name",
  "scope", "setup_ms"?, "at"?, "reused" }` (see "Fixtures" for the full
  shape and why `setup_ms`/`at` are only present on a freshly built entry).
  Teardown itself is not on this list: it runs after this step record is
  already closed, so a `scenario`-scope fixture's own teardown failure
  lands on the scenario record's `teardown_errors` instead (see
  "Fixtures").
- Step records live under `.nukadoko/records/steps/<id>/`, scenario records
  under `.nukadoko/records/scenarios/<id>/` (see "Artifacts"). Both are
  local working measurements; the durable artifacts built from them are
  sign-offs.

## Sessions, environments, secrets

The execution infrastructure Cucumber never had:

- **Sessions** carry login state across CLI calls as Playwright storageState,
  stored per environment, advisory-locked to one run at a time. No `--session`
  means a clean start; there is no implicit shared state. No daemon.
- **Environments** name deployment targets: per-environment `baseURL`,
  `envFiles`, `policy: "read-only"` (refuses mutating steps), and an optional
  `version` probe recorded on every step record as `target_version`. A sign-off
  freezes both, so a record names the deployment it was green against.
- **Secrets**: git is the classifier for *origin*. An env file git does
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
  membership in a secret-source file is: it is an instruction not to let
  that key's value spread to a *new* surface (a terminal, a CI log, a bug
  report someone pastes, an agent's own conversation transcript) just
  because the repository already has it. Both origins share one token,
  `{{secret.NAME}}`: there is no second `{{redacted.NAME}}` marker, so a
  step record reader only ever has to recognize one redaction shape. The
  same key cannot be named in both `public` and `redact`: that is a config
  error, since the two lists give opposite instructions for one key.
  Secret values, from either origin, are redacted wherever a step record is
  emitted (`record.json`, `do`'s stdout copy, http.jsonl), applied by the
  executor at write time, never controllable from a step's `run`. Honest
  limits: values shorter than 4 characters are never redacted (this floor
  applies to a `redact`-named value exactly as it does to any other
  secret), only values nukadoko itself loaded are redactable (a fresh
  token inside a step's result is not caught), and a tracked value not
  named in `secrets.redact` still reaches every one of those surfaces in
  plaintext, including an agent's own conversation log: that log did not
  exist when `.gitignore`'s tracked/untracked line was drawn, so "already
  in the repository" was never a judgment about it. Traces and
  screenshots are not redacted; the state directory is sensitive. `nuka
  check` reports each env file's classification and secret-key names
  (never values), plus three warnings: `secrets.public`/`secrets.redact`
  naming a key no configured envFile defines, `secrets.redact` naming a
  key whose value is too short to ever actually be redacted, and (for a
  tracked env file only) a key whose *name* looks like it holds a secret
  (`SECRET`, `PASSWORD`, `TOKEN`, `CREDENTIAL`, or a `KEY` suffix) but
  isn't named in `secrets.redact`. That last check is a name-pattern
  heuristic, and it is used for exactly one thing: deciding whether to
  print the warning. It never decides redaction: a name "looking like" a
  secret does not add it to what gets redacted; only git's tracked/
  untracked classification and `secrets.redact` do that.

Configuration lives in `nukadoko.config.ts` (`defineConfig`). Every key it
accepts, name and one line each; a key with more to say points at where
that is, a later paragraph here or the section documenting the feature it
belongs to:

| Key | What it holds |
| --- | --- |
| `featuresDir` | feature files and step code, `nuka run`'s own unattended set (default `features`, Cucumber-style) |
| `additionalFeatureDirs` | extra directories `nuka check`/`nuka tend` bind vocabulary against, without joining `featuresDir` (default `[]`, below) |
| `baseURL` | top-level base URL, overridden per environment (below) |
| `envFiles` | top-level env files, appended to per environment (below) |
| `environments` | per-environment `baseURL`, `envFiles`, `policy`, `version` probe (below) |
| `stateDir` | where nukadoko writes at run time (default `.nukadoko`, see "The state directory") |
| `browserType` | which Playwright engine `ctx.page()` launches: `chromium` (default), `firefox`, or `webkit` (below) |
| `browser` | Playwright's own `LaunchOptions`, passed to that engine's `launch` (below) |
| `browserContext` | Playwright's own `BrowserContextOptions`, passed to `browser.newContext()` (below) |
| `requestContext` | the matching `newContext` options for `ctx.request()` (below) |
| `secrets` | `public`/`redact` lists that adjust a key's redaction handling (above) |
| `parameterTypes` | custom cucumber-expressions parameter types (below) |
| `fixtures` | user-defined fixtures (see "Fixtures") |
| `fixtureTimeout` | default setup/teardown timeout per fixture instance, in ms (see "Fixtures") |
| `allure` | only `resultsDir` (see "Allure emitter") |
| `messages` | only `output` (see "Messages emitter") |

`additionalFeatureDirs` (default `[]`) answers a different question than
`featuresDir` does. `featuresDir` is the set that *runs* unattended: `nuka
run` with no argument iterates exactly that directory, and this key never
widens it. `featuresDir` plus `additionalFeatureDirs` together is the set
a static check *binds vocabulary against*: `nuka check` with no argument
and `nuka tend` both walk the wider set, because whether a step's pattern
is bound is a property of the whole project, not of what today's
unattended run would execute. This is where an acceptance feature (see
"Sign-off") belongs for as long as it stays outside `featuresDir`: named
in `additionalFeatureDirs`, the steps it binds are counted as bound
instead of reported `pattern-unbound`, and it still never runs
unattended. A feature that instead describes the product's own core path
moves into `featuresDir` once accepted, and needs no entry here at all.
An entry that does not exist on disk is a config mistake, not an empty
scan result to fail open on: `nuka check` reports it as an error
(`additional-feature-dir-missing`), and `nuka tend` reports the same fact
as a note.

`browserType` picks which Playwright engine `ctx.page()` launches:
`"chromium"` (default), `"firefox"`, or `"webkit"`. It is a separate key
from `browser` rather than a field inside it, because `LaunchOptions`
(`browser`'s own type, see below) has no key for an engine at all:
Playwright selects one by which of `chromium`/`firefox`/`webkit`'s own
`launch` gets called, never by an option passed to it. Mixing an engine
selector into `browser` would mean accepting a key `LaunchOptions` itself
has no room for, breaking `browser`'s own "hand Playwright's type through
unmodified" contract. Firefox and webkit each need their own binary
installed (`npx playwright install firefox`/`webkit`); whether one already
is can only be learned by launching it, so `nuka check` makes no claim about
it, and a missing binary surfaces as Playwright's own error at launch time,
neither caught nor reworded. A scenario record's own `browser` field (see
"Running") carries the engine and version a run actually launched, measured
the same way.

`browser` takes Playwright's own `LaunchOptions` type directly. zod does not
re-validate its shape beyond "is this an object": the type comes from
`defineConfig`, so `tsc` catches a typo the same way it catches one anywhere
else in `nukadoko.config.ts`; re-enumerating Playwright's options in zod
would need updating every time Playwright adds one, and a config author
would be blocked from a real option until that catch-up landed. Only
`headless` is read today, passed straight to the selected engine's own
`launch` (`browserType` above chooses which); omitted, Playwright's own
default (`headless: true`) applies. `newContext`'s options, like `viewport`,
are a different Playwright type and are not accepted through this key: see
`browserContext`/`requestContext` below.

`browserContext` and `requestContext` are `newContext`'s counterpart to
`browser`'s `launch`: `browser.newContext()` (built when a step's bag
names `page`) and `playwrightRequest.newContext()` (built when a step's
bag names `request`) are two separate Playwright calls with two separate
option types, so each gets its own config key rather than one shared key,
the same "defer to Playwright's own type" policy `browser` follows. This
is what makes an option like `ignoreHTTPSErrors` reachable at all: for a
self-signed-certificate local target, neither fixture previously had a way
to set it. Both keys reject `baseURL` and `storageState` with an error naming
the reason, rather than silently dropping them: `config.baseURL` is meant
to be the one source of a project's base URL, and nukadoko's own session
mechanism sets `storageState`, so accepting either again here would let
config quietly disagree with itself about which value is real.

A `parameterTypes` entry registers a custom cucumber-expressions parameter
type: `{ name, regexp, transformer? }`, e.g.
`{ name: "negation", regexp: /( not)?/, transformer: (s) => s === " not" }`
lets a pattern bind `will{negated:negation} return` to a plain
`z.boolean()` args key. Registration lives in config because config is
already executable TypeScript (the same reason the version probe is a
function); nukadoko has no support-file format to put it in. Names must
not collide with the built-in types: redefining what `{int}` means per
project would quietly change the meaning of every pattern that uses it.
The transformer is coercion; the args schema remains the contract.

An environment entry is `{ baseURL?, envFiles?, policy?: "read-only",
version?: () => string | Promise<string> }`. Its `baseURL` overrides the
top-level one; its `envFiles` append after the top-level list (later files
win, the common-plus-override layering dotenv users already know);
`policy` and `version` exist only per environment. No `--env` means the
name `default`, which needs no entry; an explicitly named environment must
exist: naming one asserts it does. The `version` probe is a function
because config is executable TypeScript already (a URL+jsonPath DSL would
be a worse way to write `fetch`); the tool calls it once per run with a
10-second budget, and a throw or timeout costs only `target_version`,
never the run.

`environments` and `fixtures` naming both at once:

```ts
export default defineConfig({
  baseURL: "https://acme.example",
  environments: {
    staging: { baseURL: "https://staging.acme.example", policy: "read-only" },
  },
  fixtures: {
    tenant: async ({ request }, use) => {
      const t = await createTenant(request);
      await use(t);
      await destroyTenant(request, t);
    },
  },
});
```

### The state directory

Everything nukadoko writes at run time lives under `.nukadoko/` (gitignored by
`init`); none of it is meant to be committed. It splits into three
directories, by purpose (see "Artifacts"):

- `records/steps/<id>/`: one directory per step record: the record JSON
  and its evidence files (trace.zip, screenshots, http.jsonl)
- `records/scenarios/<id>/`: one directory per scenario run: `record.json`,
  the scenario's own final screenshot, and one trace chunk per Before/After/
  AfterStep hook invocation that touched the browser (named uniquely per
  invocation, e.g. `hook-before-0.zip`, `hook-after_step-1-2.zip`, since
  more than one hook can share this one directory, unlike a step, which
  never shares its own `records/steps/<id>/`), mirroring Playwright's own
  per-test `test-results/` convention one level up. No whole-scenario
  trace.zip here: each step's own trace lives under that step's own
  `records/steps/<id>/` instead (see "Running")
- `cache/sessions/<env>/<name>.json`: storageState; live credentials in
  plaintext, created with restricted permissions
- `export/allure-results/`: the emitter's output, appended to across runs
  and safe to delete whenever a fresh Allure launch is wanted; `init` also
  creates it empty, since Allure's own CLI refuses to start against a
  missing directory but accepts an empty one, letting `allure watch` already
  be running before the first `nuka run`
- `export/messages.ndjson`: the messages emitter's output, one stream per
  run; truncated at the start of every `nuka run` (see "Messages emitter")

The durable artifacts live in the repository instead: feature files, typed
steps, and sign-off records.

## Sign-off

A sign-off records that an agreed scenario ran green at a named commit:
a claim about that one commit, not an ongoing check. The scenario is
written from the ticket's acceptance criteria, run until it is green, and
then kept as an acceptance record; nothing in nukadoko re-runs it on its
own.

Signing off and running a feature answer different questions. Signing off
records that the criteria were met at that commit; running it, in CI or
otherwise, answers whether they still hold today. Right after signing
off is where a project decides which of the two a scenario is for from
here on. Most acceptance criteria describe the change a ticket asked for,
and once that change has landed there is nothing left for a re-run to
confirm: the feature stays where it is, named in `additionalFeatureDirs`
(see "Sessions, environments, secrets") so a static check still binds its
steps without ever running it unattended. Some scenarios describe a path
through the product itself instead, one that stays true long after the
ticket closes; a feature like that moves into `featuresDir` so `nuka run`
picks it up on every future commit (see "Tending" for how its sign-off is
treated once it does).

```sh
nuka run acceptance/PROJ-123.feature     # execute, as often as needed
nuka accept acceptance/PROJ-123.feature  # freeze the last green run
```

- `accept` does not execute. Signing off is an explicit act, not a side
  effect of a green run: "keep accepting until it passes" is not a
  meaningful loop. It takes the newest green run of that feature and
  freezes it. Runs are identified by feature path, never by id: run ids
  exist for machines reading `nuka run`'s output, not for humans to type.
- The run it freezes has to cover the whole feature. A run selected with
  `<feature>:<line>` covered one scenario, so it is not a candidate however
  green it was: freezing it would leave a record beside a feature most of
  which that run never reached. The four ways this can come out are
  different situations for whoever is reading, and are reported as
  different ones: no run of this feature has ever existed, the last full
  run was red, only partial runs exist, or a green full run exists but not
  under the current condition (below). A refusal names what it read to
  decide (which run, when it started, which of its scenarios failed, or
  which conditions do have a run), so the next command is chosen against
  the record rather than guessed at.
- A sign-off is scoped to a condition: `(environment, browser)`, both read
  off the run's own measurement, never a declaration. `environment` is
  `nuka run`'s own `--env` (or the implicit `default`); `browser` is the
  engine `ScenarioRecord.browser` measured, present only for a run that
  launched one at all (see "Running"). "Chromium accepted, firefox not
  yet" is a normal state, not a stale one: a sign-off is a claim about one
  specific measured condition, and freezing two of them is two separate
  claims, not one claim updated. `nuka accept` takes its own `--env`,
  resolved the exact same way `nuka run`'s is, and selects among runs that
  match the *current* condition on both axes: `environment`, matched
  against each candidate's own measured `environment`, and `browser`,
  `config.browserType`, matched against each candidate's own measured
  `browser.type` (the same measured-vs-measured comparison every other
  declaration/measurement question in this spec makes, never the other
  way, and never against anything a candidate merely declared). A run that
  never launched a browser at all is a candidate regardless of
  `browserType`: an unmeasured axis is not part of what that run actually
  confirmed, which is why an API-only scenario's acceptance never depends
  on engine choice. When nothing matches, the refusal lists every
  `(environment, browser)` pair that does have a green full run instead.
- It refuses unless the working tree is completely clean, untracked files
  included, and the run it is freezing happened at the current HEAD. The
  record's whole claim is "this scenario was green at commit X"; an
  untracked step file the discovery would have loaded, or a commit made
  between the run and the sign-off, makes that claim false. The scenario
  record grows one field to make this checkable: the commit the working
  tree was at when the run started. An acceptance record, of any feature,
  is never part of what counts as dirty here: it is what accepting itself
  produces, never an input the run being frozen read, so its sitting there
  untracked or changed cannot make that run's own claim any less true.
  Judged the same way `nuka tend` already tells a record apart from an
  ordinary file (frontmatter carrying
  `run_id`/`commit`/`feature`/`scenarios`, see "Tending"), never by
  whether git happens to be tracking it yet. A path this cannot even
  read, most likely one deleted since it was measured, still counts as
  dirty: a missing record is a real change, not the thing this carve-out
  is for.
- A red run produces nothing. There is no verdict field and no record of
  failure: a scenario that did not pass gets fixed and re-run, and what is
  worth keeping is the outcome, not the attempts.
- The record is written beside the feature it came from, named
  `<feature-basename>.<date>-<sha>.<environment>.<browser>.md`, the
  accepted run's own condition folded into the name (`<browser>` is the
  literal `no-browser` when the run launched none) so two conditions never
  collide, silently overwriting one another, at the same commit on the
  same day. The browser's *version* is never in the filename: the engine's
  type is enough to identify which condition a record is for, and the
  version lives in the record body only (below). nukadoko does not choose
  a directory: where a feature lives, and whether it moves into
  `featuresDir`, is the project's own decision (above). The record is
  always written beside the feature, wherever that is, so moving the
  feature carries its record along.
- On success, `nuka accept` writes the record's own path to stdout,
  unchanged by anything below, and, on stderr, asks the same question a
  project already had to answer above: does this feature describe the
  change or the product's own path, and what each answer means for where
  it lives. Guidance, not a verdict: the command has no way to measure
  which one a feature is, only to name the choice.
- The record's own body carries a "Condition" section, near the top: the
  `environment` and, when the accepted run launched a browser, its measured
  engine and version; when it did not, the section says so explicitly
  rather than leaving anything blank, so "no browser was launched" stays
  distinguishable from a field a reader forgot to check. A record accepted
  before this existed carries no such section: `nuka tend` treats that as
  "condition unknown", never guesses at one, and never lets a note compare
  it against anything (see "Tending").
- The acceptance record is built by the tool from the run it freezes: the
  feature's full text, the scenario record, and each step's own step
  record with evidence stripped (traces and screenshots stay in
  `.nukadoko/`, and a CI artifact is where they belong when they are
  wanted at all). Never transcribed by a human: transcription would demote
  a measurement back to a claim.
- The record's own tail carries one more section, "Declared vs observed":
  every step across every scenario in the record whose step record declared
  `mutates: false` but was measured making at least one write
  (`observed.http_writes > 0`, see Keyword semantics), stated as a raw
  fact (declared value beside the observed count), never a verdict. It
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
  criteria is made where the translation happens: in PR review of that
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

1. Read the vocabulary: `nuka steps --json`, then `nuka describe <step>`
   for the contract of anything that looks relevant.
2. When an operation is missing, `nuka scaffold <name>`, implement it, and
   exercise it alone with `nuka do` until its step record looks right.
3. Write the feature. A tag and the description under `Feature:` carry the
   ticket id and the criteria in the reviewer's words; the scenarios are
   those criteria translated into the vocabulary.
4. `nuka check <feature>` (undefined steps, pattern/schema mismatches, a
   Then bound to a mutating step) before anything runs. Pass the path
   unless the directory the acceptance feature lives in is listed in
   `additionalFeatureDirs`: a bare `nuka check` walks `featuresDir` and that
   list, so a feature deliberately kept outside `featuresDir` and named
   nowhere else is exactly what it does not reach.
5. Commit. A run can only be frozen if it happened on a clean tree at the
   commit still checked out, so debugging runs against a dirty tree are
   fine; they simply cannot be accepted.
6. `nuka run <feature>` until green.
7. `nuka accept <feature>`, then commit the record it wrote.

Steps 1-4 are where the work and the review are: new typed steps and the
feature itself are ordinary PR material, and the translation from criteria
to scenarios is the judgment a reviewer is there to check. Steps 5-7 are
mechanical, and the tool refuses rather than let them go wrong quietly.

That loop starts from criteria. "Harvesting" below is the other way in,
for work that started by exploring instead, and it joins this loop at
step 3.

## Harvesting

`nuka do` is the adaptive loop (see "Single steps"): the agent reads one
validated result and decides the next call. What it leaves behind is
deliberately not evidence, because an ad-hoc sequence is a working record
and nothing agreed it was the story. So an exploration that found
something real ends with the finding in a form nothing can gate on, and
the path it took living only in a directory that is safe to delete.

`nuka harvest <step-record-id>...` prints one feature draft to stdout,
built from those records. It is the bridge between the two things this
tool keeps apart: a path found by adapting, and a path fixed in a
sentence someone agreed to.

```sh
nuka harvest step-20260817-a1b2 step-20260817-c3d4 > acceptance/cart.feature
```

The division of labor is the same one the whole tool runs on. Harvest
fills in what it measured, exactly: which steps ran, in what order, the
text of each line, and which values came from an earlier execution rather
than from the line. It leaves every **claim** blank, because a claim is
not something a step record contains.

Two blanks, and they are the same kind of blank. `Feature:` and
`Scenario:` get a placeholder rather than a generated name. Every line
gets `*` rather than `Given`, `When`, or `Then`. A keyword says what a
line is for the person reading it, and the records say only what ran, so
choosing one would be the tool inventing a claim it cannot support. `*`
is a real Gherkin keyword that carries no position, so the draft parses
and `nuka check` can read it while the narrative is still missing.

Deriving the keyword from `mutates` was the alternative, and it was
rejected for the reason a wrong guess is worse here than no guess: a
plausible keyword survives review, and `*` does not. Whoever finishes the
draft, agent or person, is the same party that would have had to check a
guess anyway.

**Which records form one sequence is said on the command line, not stored.**
`do` has no grouping label on purpose, and adding one would make an
ad-hoc sequence start to look like the thing it is not. Nothing needs to
be added: each `do` prints its own step record, so the caller running the
adaptive loop already holds every id. A time window (`--since`, `--last
10`) would guess instead, and would quietly pull in the probe that was
tried and abandoned, which is exactly the line a reader cannot tell from
a real one.

What the command line says is *which* records, never their order. The
draft follows each record's own `started_at`, so a caller that lists two
ids the wrong way round still gets the sequence that ran. Order is a
measurement here, and the argument list is a selection.

A value that never appears on a line is left to chain. A step record's
`used` names which execution supplied each `from` key (see "Records"),
which is a measurement rather than a reconstruction, so harvest writes
nothing for that key and lets the producer's own line supply it. The
binding-order check `nuka check` and `nuka run` share then proves the
order before anything runs. A key that came from `--args` instead is
written into the line where a capture takes it, or into a docstring or
table where the one unconsumed required key can take it (see "Typed
steps"). A key that fits none of those is left out with a comment saying
so, and `check` refuses the line for the same reason it always would.

Three things are recorded rather than resolved, each in the draft and on
stderr both.

- **A step with no `pattern`** cannot be a line at all. It becomes a
  comment naming the step and its args. Whether it was a step whose
  sentence has not been written yet, or a part that belongs inside another
  step, is a judgment about what the scenario is for, so the draft states
  the fact and leaves the judgment.
- **A record whose execution failed** becomes a line, with a comment
  saying it failed when it ran and how. This keeps the case worth having:
  an exploration that reproduced a bug harvests into a scenario that is
  red until the behavior changes, then green, then acceptable. Nothing
  about a red draft can turn into evidence by accident, because
  `nuka accept` refuses without a green full run (see "Sign-off"). A
  failed record also cannot be a chain's upstream, since `--use` already
  refuses one, so reconstruction stays sound.
- **A line that does not read back** to the record it came from. A
  pattern may carry optional text (`item(s)`) or alternation (`is/are`),
  and reversing one does not have a single answer. Rather than pick
  quietly, harvest reads every line it wrote back through the same
  matching `nuka run` uses and checks that it lands on the same step with
  the same args. A line that does not is named, with what was written and
  what it read back as.

That round trip is the one place harvest judges its own output, and it
reuses `run`'s own matching rather than a second implementation, so the
two can never disagree about what a line means.

Provenance goes to stderr and never into the file. The ids point into the
state directory, which is gitignored and safe to delete (see "The state
directory"), so a comment naming them inside a committed feature would
become a reference its reader cannot follow. The working information
belongs where the work is happening; the feature file is a durable
artifact and keeps only what stays true.

A step record from `nuka run` is refused rather than harvested. That
record already belongs to a feature, and the useful answer is the feature
it belongs to rather than a second one generated from it, so the refusal
names the scenario record it came from.

## Allure emitter

`nuka run` writes one Allure test result per *step*, the moment that step
finishes, and one more per *scenario*, once that scenario ends, to the
`export/allure-results/` directory (Allure 2 file format, readable by both
Allure 2 and 3): nukadoko's only presentation layer; nukadoko itself renders
nothing.

- The output location defaults to `.nukadoko/export/allure-results/` (the
  state directory's own `export/allure-results/`, above); `allure.resultsDir`
  in `nukadoko.config.ts` moves it to any other root-relative path. There is
  no `enabled` flag and no CLI flag: the emitter always runs, so zero
  configuration already produces a full report. It is skipped only when a
  `nuka run` invocation selects zero pickles (no `allure-results/` is
  created at all in that case), the same reason BeforeAll/AfterAll are
  skipped for it.
- Writing is append-only: an existing `allure-results/` directory is never
  cleared or replaced. Whether two `nuka run` invocations count as one
  Allure launch or two is left to the caller; a user who wants a fresh
  launch removes the directory themselves.
- `allure-results/` is safe to read while `nuka run` is still going, and
  reading it while a run is going is the reason step became the unit: a
  20-step scenario that takes minutes used to leave the report blank until
  the last step finished, because a scenario was the smallest thing Allure
  had a result for. Now each step's own result lands the moment that step
  finishes, so a dashboard already open updates step by step rather than
  scenario by scenario; landing latency was measured at 150-351ms. `nuka
  init` creates `.nukadoko/export/allure-results/` empty up front for
  exactly this (see "The state directory"), so `allure watch` can already be running
  before the first `nuka run` even starts. `categories.json`/
  `environment.properties` are written once, at the very start of the run,
  before the first step starts. Running `allure generate` against the
  directory mid-run reports every step that has landed so far; nothing
  about the directory's own consistency depends on the run having
  completed.
- Each gherkin step becomes its own Allure test result, not an Allure step
  nested inside a scenario's test the way it was before. The scenario
  becomes that test's `suite` label and the feature stays its `parentSuite`
  (unchanged); Allure's default tree already groups by exactly that pair,
  so a suite row still carries the whole scenario's tally and turns red as
  soon as one of its steps does, the same as before, even though the
  `suite` slot itself was empty until now. Each Before/After hook still
  becomes its own fixture (Allure container), unchanged.
- Each scenario also gets one more Allure test result of its own, written
  once that scenario ends, named `Scenario: <scenario name>` so its own
  leaf in the tree is never mistaken for one of its steps'. It sits in the
  same `suite`/`parentSuite` pair as its own steps, so the tree still
  groups both grains under one row rather than splitting them across two.
  Unlike a step's own test (see the identity bullets below), a scenario's
  own test is given an identity that is deliberately stable from one run
  to the next, which is what makes Allure's own history, trend, and
  flaky-across-runs views work again, at scenario grain, something a
  step's own test can never promise.
- A scenario stopped by its own Before hook still shows every one of its
  own steps as `skipped`, with the hook's own failure visible only inside
  that hook's own fixture, because a step-level test still has nowhere
  else to put a failure that happened before that step ever ran. The
  scenario's own test result (above) is what changed: it carries the
  hook's failure directly, reading `failed`, the same status `nuka run`'s
  own exit code and the `record.json` it writes already reported. Before
  the scenario got a test result of its own, a hook's failure had nowhere
  red to land on the report at all; the scenario-level test closes that
  gap.
- Attachments: per step, its own trace, HTTP log, and validated result,
  attached to that step's own test result. The scenario's own screenshot
  (`final.png`, taken once at teardown) attaches instead to a synthetic
  fixture named "Scenario evidence," since by the time it is captured every
  step's own test, and the scenario's own test result above, have already
  been written to disk, with nothing left for it to attach to directly.
  Separately, whatever a step declared about itself (an attachment, a
  link, a log line) is emitted too, always under a name prefixed
  `declared:`; that prefix is the one place where provenance (measured by
  nukadoko vs. self-reported by the step) survives once everything is
  sitting in the same result file.
- Every step whose record exists, passing or failing alike, also gets that
  whole step record attached verbatim, as `record.json`. It is the same
  object that reached disk (already redacted there, so nothing here
  redacts it a second time), attached whole rather than picked apart field
  by field, on purpose: a field added to `record.json` later shows up in
  the report on its own, with no emitter change needed to carry it there.
  The individually mapped fields below stay too, since a reader who wants
  one fact should not have to open an attachment to get it; `record.json`
  is the fallback that keeps the report complete even where an individual
  mapping was never written.
- A step's own `sections`, `polls`, and `actions` (see Records) become one
  child-step timeline nested directly under that step's own test, one level
  shallower than before this change (a step used to be nested inside a
  scenario's test itself, and the timeline nested inside that). Merged in
  ascending `at` order; two entries that land on the exact same millisecond
  keep a fixed order, `sections` before `polls` before `actions`, so a
  rerun of the same step record never reshuffles the timeline into an
  unreadable diff. A section
  renders as a zero-width marker named after its own label. A poll spans
  its own start through `waited_ms` later, named `<description>
  (<attempts> attempts)`, so a wait that resolved in one attempt reads
  differently from one that took forty without opening the step record: the
  duration alone cannot tell those two apart, and the count is the one fact
  only the name can carry here. A poll's own outcome sets the child step's
  status: `resolved` is passed, `timed_out` is failed (the condition it
  waited for was never met, the step's own contract not holding), `failed`
  is broken (the poll's callback itself threw, unrelated to whatever it was
  waiting for). An action spans its own start through `ms` later, named
  after its own `method` plus, when the call carried one, its `selector` or
  `url` (e.g. `goto /orders`); an `expect` call is named with its matcher
  and target instead (e.g. `expect #late to.be.visible`, with `not` folded
  in for a negated assertion), since neither is implied by `method` alone
  the way a `goto`'s own target is implied by `url`. Neither `ms` nor
  `timeout_ms` ever lands in the name: `ms` is already visible as the child
  step's own width, the same reason `page_events`'s counts stay off step
  names too, and `timeout_ms` stays in the `record.json` attachment. An
  action's own `outcome` sets the child step's status, passed or failed,
  no third bucket: unlike a poll, a Playwright call either resolved the way
  the step asked or it did not. When `actions` itself was capped at 100
  entries (see Records, `truncated.actions`), the timeline gets one more
  child step at its own tail, zero-width and passed, naming the cut (e.g.
  `... 4113 more actions not shown`), for the same reason `page_events`'s
  own `truncated` field exists: a reader scanning only the timeline must
  never mistake a capped list for everything that happened. Never clamped
  to the parent step's own start/stop range: a timeline entry outside that
  range already happened, and hiding it would make it unreadable rather
  than making it not true.
- A hook invocation's own trace and `actions` (see "Compat steps", above) attach
  to that same hook's own fixture, not to the test result itself: the trace
  as an attachment named `trace`, the same contentType as a step's own, and
  `actions` merged into that fixture's own child-step timeline through the
  identical mechanism the bullet above describes. A hook carries no
  `sections`/`polls` to merge in alongside them, since it has no fixture
  bag to call `section`/`poll` from, but its own trace-derived `actions`
  still render the same way a step's would. A hook invocation that never
  touched `this.openPage()` gets neither: no trace attachment, no timeline
  entries, the same "nothing to show" a step that never destructured
  `page` already gets.
- `page_events` (see Records) surfaces as up to three more parameters,
  `console errors (observed)`, `page errors (observed)`, `failed requests
  (observed)`, one per category that recorded at least one entry, so a
  reader sees the count without opening the `record.json` attachment that
  already carries every entry in full. A category the collector truncated
  (see Records, `page_events.truncated`) reports its true total beside the
  shown count, e.g. `100 of 4213`: the shown count alone would understate
  what actually happened.
- A step's parameters carry its declaration and what was actually observed
  side by side: `mutates (declared)` next to the measured `http reads
  (observed)` / `http writes (observed)` (and, for a compat step, `world
  reads (observed)` / `world writes (observed)`), not because the two are
  checked against each other automatically, but so a reviewer can: the
  declaration is what nukadoko trusts and acts on, the observed counts are
  what actually happened, and this row is where the two sit close enough to
  compare by eye. The observed side is an HTTP-method proxy, not a semantic
  judgment (see Keyword semantics): a row can show a truthful `mutates
  (declared): false` next to a nonzero `http writes (observed)` when the
  step called a POST-based read, and that is the proxy showing through the
  table, not either number lying.
- Three more parameters, `nukadoko.run`, `nukadoko.scenario`, `nukadoko.step`,
  carry that step's run id, scenario id, and position, `mode: "hidden"` so
  none of the three ever shows up in the UI. They exist to keep every step's
  own `historyId` apart on purpose (see below), not to surface anything to
  a reader.
- A failed step's message is prefixed `[nukadoko.failure=<kind>]`, naming
  the same `error.kind` its step record already carries; the same `error.kind`
  is also written as a `nukadoko.failure` result label. The two Allure
  generations turn that into a category by different paths, and they need
  different things from a user.
- **Allure 2** has no per-result category field, so the emitter also writes
  `categories.json` (one rule per `error.kind`, all seven, every run,
  matching the message prefix by regex): the message prefix and the
  category rule are two views of the same classification, and no user
  configuration is needed.
- **Allure 3**'s `allure generate`/`allure report` never read a results
  directory's `categories.json`: categories there come only from Allure 3's
  own config, matched against a result's labels, and `nukadoko.failure` is
  exactly such a label. `nuka init` writes `allurerc.mjs` at the project
  root with seven label-matcher rules, one per `error.kind`, built from
  `NAME_BY_KIND` (`src/report/allure/categories.ts`) so the names can never
  drift from the ones the emitter itself uses; dropped at a project's root
  it is picked up automatically (Allure 3 auto-detects
  `allurerc.{js,mjs,cjs,json,yaml,yml}` from the current working directory,
  no `--config` flag needed). `init` checks all six extensions first and
  writes nothing, naming the file it found on stderr, when a project
  already has one. Without any of them, every nukadoko failure lands in
  Allure 3's one built-in "Product errors" category instead. A project not
  using `nuka init` can still copy
  [`examples/allure/allurerc.mjs`](https://github.com/meganemura/nukadoko/blob/main/examples/allure/allurerc.mjs)
  by hand.
- **`fullName` (`<feature path>#<scenario name>#<step text>`) and
  `testCaseId` (a hash of `fullName`) are computed the same way the official
  cucumberjs Allure adapter computes them, for a step's own test. `historyId`
  is not, on purpose, and Allure's history, trend, and flaky-across-runs
  detection do not work at step grain.** They all key off `historyId`
  matching from one run to the next, and a step has nothing stable to match
  on: unlike a scenario, a step carries no id of its own anywhere in the
  record. Four ways of computing one anyway were tried, and every one of
  them mis-links two different steps as if they were the same one. Step
  text collides with itself (two steps can share the exact same wording).
  Position (index, line number) shifts whenever anything earlier in the
  feature file is edited. Counting occurrences cannot tell an inserted
  duplicate from the original it landed next to. The line-number scheme was
  the one that made the failure mode concrete: adding one comment line at
  the top of a feature file silently re-pointed every step at its
  neighbour's history, and the output gave no hint that it had happened,
  not a warning, not a mismatched count, nothing a reader could have
  caught. Given that a wrong link is worse than no link and every scheme
  tried produces one, the only choice that does not eventually lie for a
  step is to make sure nothing links across runs at all: a step's own
  `historyId` carries the three hidden parameters above
  (`nukadoko.run`/`nukadoko.scenario`/`nukadoko.step`), which change on
  every run and force every step's own `historyId` apart, deliberately.
  They are `mode: "hidden"` rather than `excluded: true` on purpose too:
  Allure drops an `excluded` parameter before hashing it, which would undo
  the whole point, where `hidden` only keeps a parameter out of the UI.
- **A scenario's own test carries a `fullName` of `<feature path>#<scenario
  name>` instead, with nothing appended, and its own `historyId`
  deliberately carries no run id, scenario id, or step index, so it
  matches across two runs of the same scenario: that is what makes
  Allure's history, trend, and flaky-across-runs views work here, at
  scenario grain, provided `historyPath` (below) is set.** Unlike a step, a scenario
  already has a stable natural key to build that on: its own feature path
  and gherkin name. The one gap a bare path-plus-name key leaves open is
  the same one a hidden `nukadoko.scenario.steps` parameter closes: two
  scenarios can share a gherkin name, most often two rows of one Scenario
  Outline, and a shared name alone would hash both to the same
  `historyId`, wrongly folding the second row into the first row's
  history. `nukadoko.scenario.steps` (every one of that scenario's own
  step texts, joined) is folded into the hash to tell them apart, and an
  Outline row's own Examples values are folded in too, unhidden, which is
  usually enough on its own. What neither one can rescue is two scenarios
  sharing a name *and* every step's own text, with no Examples row to tell
  them apart: that pair stays genuinely indistinguishable, on purpose, for
  the same reason a step's own identity was given up on above: a wrong
  link is worse than no link.
- `historyPath`, set in `allurerc.mjs` (Allure 3's own config, not
  nukadoko's), is what makes a scenario's own history above actually
  visible: without it, Allure 3's own `generate`/`watch`/`report` never
  build history at all, no matter how stable a scenario's own `historyId`
  is. A project with a perfectly stable identity and no `historyPath`
  still sees no trend, no regressed/fixed transition, no flaky detection,
  and nothing in the report itself points at a missing config key as the
  reason. `nuka init` writes it unconditionally into the `allurerc.mjs` it
  generates (`.nukadoko/export/allure-history.jsonl`, kept beside the
  disposable `allure-results/` directory rather than inside it, so
  clearing results between runs never discards it);
  [`examples/allure/allurerc.mjs`](https://github.com/meganemura/nukadoko/blob/main/examples/allure/allurerc.mjs),
  for a project not using `nuka init`, carries the same field, so copying
  it by hand gets history too, not only categories. Setting `historyPath`
  never makes a step's own history visible, only a scenario's: Allure
  still appends one history point per result it sees on every
  `generate`/`watch`/`report`, so a step's own entry, whose `historyId`
  never recurs, still lands in `history.jsonl` every run, once per step,
  and simply never resolves to a continuation of anything earlier.
  nukadoko does not drive `allure generate` itself and has no way to keep
  that file from accumulating those disposable step-grain entries.
- A team migrating an existing suite onto nukadoko does not carry that
  suite's own Allure history, trend, or retry tracking across the move: the
  old history was computed under a different tool's own `historyId`
  formula, one nukadoko does not reuse, and this is a choice, not a gap to
  file: the compat door exists to let a suite move onto nukadoko, not to
  be where it settles. Once on nukadoko, a scenario's own history starts
  building fresh from nukadoko's own runs, at scenario grain (immediately
  above); a step's own history never builds at all, on purpose, for the
  same reason as before: nothing in this codebase gives a step a stable
  identity to build one from. Time-over-time observation at step grain has
  a home here instead: `nuka tend`'s sign-off rot findings and its
  `post-navigation-read` note (see "Tending"), both read from what was
  actually accepted rather than from a chain of report entries that would
  have to trust a step's identity to be right.
- Ad-hoc `do` step records are working records, not test results, and do not
  appear on the dashboard: what an exploration proves is expressed by
  repairing or writing a scenario, and that scenario run is what Allure
  shows.
- Viewing one run is Allure's job, and nukadoko has no web UI of its own.
  History, trend, and flakiness are Allure features too; per the two
  identity bullets above, this emitter feeds them at scenario grain, once
  `historyPath` is set, and never at step grain: what Allure shows for any
  one `nuka run` invocation is complete on its own, and nothing about a
  later invocation's steps links back to this one's, only its scenarios do.
- Confirmed against a real browser, not just against `allure-js-commons`'
  own API: running `nuka run` against a small fixture with a passing, a
  failing, and a Before-hook-stopped scenario, generating the report with
  the real `allure` CLI, serving it over a real HTTP server (the report's
  SPA fetches its own `widgets/*.json` on load, which `file://` cannot
  serve at all, though its shell still renders regardless, so a check has
  to read something data-dependent to mean anything), and driving a real
  headless browser against it. What that confirmed: the report's own
  pass/failed/skipped counts match what `nuka run` itself reported, at
  both grains combined; each scenario renders as its own tree group,
  holding its own leaf alongside each of its steps' leaves; a failed
  step's `record.json` attachment is present and its own content is
  readable (naming that step's own record id); `nuka init`'s own
  `allurerc.mjs` (above) actually sorts a failure into its own category
  rather than Allure 3's default "Product errors"; and a step's own
  `sections`/`polls` render as its own child steps, one level under that
  step, not two. Also confirmed, and pinned rather than treated as
  incidental: a scenario a Before hook stops shows every one of its own
  step-grain leaves skipped, not red, the same way it does once generated,
  while its own scenario-grain leaf shows `failed`, closing the display gap
  named earlier in this section, seen for real, not only in a unit test.
  `allure watch` serving a live report while a run is still going is
  confirmed the same way: its result count rises above zero mid-run and
  matches the finished run's own count once it exits. Not yet exercised
  this way: a hook's own trace attachment (left to a later stage).

Not yet built: a hook's own duration (record.json carries no per-hook
timestamp today, so a hook's start and stop both collapse to the
scenario's own boundary), BeforeAll/AfterAll (no run-level record exists
for the emitter to map from), and link-template configuration (mapping a
tag like `@issue:123` to a URL).

The point is not format politics: a classic cucumber run fills an Allure
report only where glue authors hand-attached evidence, while nukadoko's
harness measures everything anyway, and Allure's own model (attachments,
labels, parameters) already had a first-class place for all of it. The
Allure emitter is where nukadoko's measurement surplus becomes visible,
automatically, today; the messages emitter below is the second, narrower
output, and its job is compat fidelity rather than measurement surplus.

## Messages emitter

`nuka run` writes one cucumber messages stream (NDJSON, one envelope per
line, via `@cucumber/messages`) per invocation, defaulting to
`.nukadoko/export/messages.ndjson`; `messages.output` in `nukadoko.config.ts`
moves it to any other root-relative path. There is no `enabled` flag and
no CLI flag, the same as Allure: the emitter always runs, and it is
skipped only when a `nuka run` invocation selects zero pickles.

- One run is one stream is one file: `begin` truncates the output rather
  than appending, because appending would leave two `testRunStarted`
  envelopes in one file: no longer a single well-formed stream to read
  back. `nuka run` runs one feature per invocation, so running a second
  feature afterward overwrites the first stream: the intended consequence
  of "one file, truncated," not an oversight.
- This emitter's role is the Allure emitter's inverse. Allure is where
  nukadoko's measurement surplus becomes visible; this one is compat
  fidelity, full stop: its only job is that a migrated suite's existing
  formatters and JUnit-based CI keep reading a nukadoko-produced run the
  way they read a classic cucumber-js one.
- Step record internals stay out of the stream entirely: no validated result,
  no `mutates`, no `observed` counts, no `error.kind`, no `calls`.
  `TestStepResult` and
  `TestStepFinished` are closed schemas (`additionalProperties: false`)
  with no field for any of them, and there is no smuggling them in through
  a marker the way Allure's own `[nukadoko.failure=<kind>]` label does.
  `calls` carries a second reason on top of that one: this format has no
  step inside a step, so a part would have no shape to take here even if
  the schemas were open (see "Parts"). Allure nests one because Allure's
  own model does.
- Attachments are limited to what a step declared about itself: `declared`
  attachments and log lines, the latter riding cucumber-js's own
  `text/x.cucumber.log+plain` media type (the one `this.log()` produces).
  Trace, screenshots, the HTTP log, and the validated result stay
  Allure-only: that measurement surplus already has a home, and
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
  resolve (pickle to testCase to testStepFinished, `pickleStepId` back to
  the gherkin step) does resolve. A failed scenario's `<failure>` carries
  the step's own error message, `<system-out>` carries a per-step
  passed/failed/skipped trace, and `<testsuite tests="...">` matches the
  real scenario count; `<failure>` itself gets no `type` or `message`
  attribute, because `TestStepResult.exception` is never set (below).
  Only the junit-xml path has been run this way: an official HTML report
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
protocol requires `Exception.type` and a step record only ever carries a
message: the reason a failed step's JUnit `<failure>` is body-only.

## Self-healing, audited

When a scripted scenario breaks (the app changed, the pattern no longer
matches reality), the repair loop is:

1. An agent re-runs the goal adaptively via `nuka do`, one step at a time,
   reading each step record to decide the next call.
2. The step records record what actually worked: a sequence that deviates
   from the scripted scenario. They are the narrative, not the proof: the
   agent may cite them in the PR as the story of the repair.
3. The PR updates the typed steps and/or the feature file, and its proof is
   the repaired scenario running green: a scenario record and its step
   records, reviewed like any other change. Attestation always flows
   through the scenario, never through an ad-hoc sequence.

nukadoko's contribution is that every stage leaves a record; the authoring is an
agent workflow (bundled skill), not engine magic. Self-healing without an
audit trail is how test suites silently stop testing anything: the deviation
record is the point.

## Tending

`nuka check` answers one question: can this project run right now. A
project can pass it every time and still be rotting. A sign-off can stop
describing the code it froze. A declaration can go years without anything
exercising it. A contract can be unreadable to the agent that has to pick
it. None of that stops a run, and all of it costs more the longer it sits,
which is the failure mode this tool is named after. A nukadoko tended
daily matures; neglected, it dies.

`nuka tend` answers the other question: is this vocabulary, and the record
it has produced, still healthy.

The reason it is a separate command rather than more warnings on `check`
is that the two are read at different moments and mean different things.
`check` runs before every run, in CI, inside an agent's loop, and every
line it prints is something standing between the project and a green run,
which is why a finding there has to be worth stopping for. Tending
findings are not: nothing here has to be fixed today, and if they appeared
on every `check`, they would teach everyone to skim past the line that
did have to be fixed. Noise is not a cosmetic problem in a tool whose main
claim is that its checks are worth reading.

Before any finding, `tend` prints three summary lines that state where the
bed currently is. None of the three is a finding, and none touches the exit
code (a suite in the middle of a migration is in a normal state, not a
faulty one, and warning about it every time would drown the findings that
do need acting on):

- `scanned:` names every directory this run actually looked at:
  `featuresDir` plus each `additionalFeatureDirs` entry (see "Sessions,
  environments, secrets"). Printed first, because a count means nothing
  until a reader knows what it was counted over.
- `bed:` gives how much of the vocabulary is typed rather than still
  compat, plus how many of the typed steps declare `mutates: false`
  (read-only).
- `declared:` gives how much of what a typed step could declare
  (`rationale`, a `.describe()` on each schema field) is actually
  declared.

It exists because the information was already there and unread. A step
record's `world` and `declared` counts do shrink as a suite promotes, which
is true and useless as a way for a person to see progress: nobody reads a
directory of step records to work out how far along they are. Stating it once, in the
command whose whole subject is the health of the bed, is what makes it
something anyone actually sees.

What it looks at, and why each one is rot rather than style:

- **A sign-off that no longer matches the code it froze.** A record
  carries the feature source it accepted and every step record from that run.
  If a frozen `result` no longer passes its step's current `returns`
  schema, or the frozen feature source no longer matches the file it was
  taken from, or a step it cites is gone from the vocabulary, then the
  record is still on disk making a claim it can no longer support. This
  is the one finding here that is an error rather than a note: a sign-off
  that has quietly stopped meaning what it says is worse than no sign-off,
  because it is still being counted. None of this is checked once the
  feature the record names has moved into `featuresDir`: from then on the
  running suite carries the guarantee, not a record frozen at one commit,
  and a warning that fires on every ordinary edit to a feature already
  running unattended would stop being read. The one exception is a record
  `tend` cannot even parse (`signoff-record-unreadable`, above): its own
  `feature:` value may not have parsed either, so there is no placement
  to judge it by, and a file that looks like a record but cannot be read
  is a fact about the file, not about whether its claim is still current.
- **A sign-off's own recorded condition drifting from the config.** A
  sign-off is scoped to a condition (see "Sign-off"): `(environment,
  browser)`, both measured, never declared. If the most recent sign-off for
  a feature recorded a browser the project's config no longer declares,
  nothing about that sign-off is wrong right now, which is why this is a
  note rather than an error, unlike the finding above. A record accepted
  before this note existed carries no condition to compare against at all,
  so it is left out of this finding entirely rather than guessed at. Like
  the finding above, this stops once the feature has moved into
  `featuresDir`: the drifting condition belongs to a claim nothing depends
  on any more.
- **A step file that failed to import.** `tend` discovers steps the same
  tolerant way `nuka check` does (see "Tolerant reporting, fail-fast
  execution"): a broken glue file is skipped rather than stopping the run,
  so whatever it would have contributed is silently missing from every
  count and finding here, not absent because nothing failed. One note for
  the whole run, not one per file: a broken file's own cause is `nuka
  check`'s own finding (`step-file-import-failed`), so this one only says
  how many steps went unseen and names the files, and does not touch the
  exit code.
- **A `from` declaration nothing exercises.** Every occurrence of the step
  across every feature captures that key from the line, so the declared
  producer never supplies anything. Reported as the fact it is (the
  declaration may still be reached through `nuka do --use`), not as a
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
  defines.** A real instruction reaching nothing: configuration that has
  drifted from the files it describes. Also moved from `check` for the same
  reason: nothing about it changes whether this run should happen. Its
  neighbors stay on `check` and are worth the contrast: a `redact` entry
  whose value is too short to be redacted, and a tracked env file with a
  secret-looking key, both mean plaintext reaches a log the moment the run
  starts, which is exactly something to know beforehand.
- **A configured `additionalFeatureDirs` entry that does not exist on
  disk.** It was named specifically to widen what `nuka check`/`nuka tend`
  scan, so an absent directory is a config mistake to report, the same way
  a missing `featuresDir` is, except `tend` has no error bucket for a
  config mistake the way `check` does, so this is a note here even though
  `nuka check` reports the identical fact as an error.
- **An accepted feature outside every directory `nuka check`/`nuka tend`
  scan.** A sign-off record already proves that feature ran green, but a
  feature nothing here walks still leaves the steps it binds looking
  `pattern-unbound` to every other finding in this report. Sign-off
  records are read for this finding's visibility only, never to decide
  what gets scanned: growing the scanned set from them would only ever
  notice a feature that has already been accepted at least once, silently
  missing the one still being drafted: exactly the feature a false
  `pattern-unbound` would most mislead someone about. Naming the
  directory in `additionalFeatureDirs` is what actually fixes it.
- **A step whose own trace shows another call landing close behind a
  navigation call.** Read from a frozen sign-off record's step record
  alone, never a live run's (`.nukadoko` stays out of this walk the same
  way it does every other one here): for each `goto`, `reload`, `goBack`,
  or `goForward` in that step record's own `actions`, the gap to whatever
  call the step made next. A read that lands inside the same step
  record's own `ctx.poll` window is left out: a step written to `poll()`
  the way the doctrine in "Context API" already asks for is retrying by
  construction, not the thing this note exists to tell apart from it. What
  is reported is only the gap itself, never a verdict: how long a page
  takes to render after a navigation is nothing this tool measures, and no
  table of which Playwright calls auto-wait is built to guess at it, since a
  table like that would describe a dependency's own semantics rather than
  something this tool measured, and go stale the moment that dependency
  changed. A step record with no `actions` at all, the shape a record
  written before that field existed still carries, is silently out of
  scope, not an error.

This last finding is the plainest reason the whole list above lives on
`tend` and not `check`. The step it names already ran green, and its step
record already froze that pass; nothing about it is broken today, and no
run is blocked by it. What changed is only that the tool can now see a
fact about how that pass happened, not that the pass stopped being real.
`check` exists to answer whether a run can proceed right now, so a step
that already passed has nothing left for it to say; `tend` exists to
answer whether what already passed is still healthy, and "has not yet lost
a race it happens to be running" is exactly the kind of health that
question is for. Reporting this as an error would treat a symptom that has
not appeared as though it already had.

Findings are `--json` like everything else. The sign-off finding exits
non-zero so a periodic job can act on it; the rest do not, because a
project is allowed to carry them.

`tend` reports and does not repair. Fixing means writing a description,
deleting a step, or re-accepting a feature: decisions with an author
behind them, which is the same reason `accept` refuses rather than
fixes up a dirty tree.

## CLI summary

The npm package is `nukadoko`; the one command it installs is `nuka`.

```
nuka run <feature[:line]|dir>
                              execute scenarios; step records + allure-results.
                              :line runs one scenario, for iteration only — a
                              partial run can never be accepted. A directory
                              is walked recursively for .feature files, in
                              deterministic byte order, folded into this one
                              invocation: one run_id, one summary, one exit
                              code, one messages stream, one Allure results
                              tree. :line on a directory is refused, and a
                              directory with no .feature file anywhere under
                              it fails setup, naming what it walked. stderr
                              gets per-step/per-scenario progress as it runs,
                              then every location this run wrote and a summary
                              line; --quiet drops the progress lines only.
                              stdout stays NDJSON, one record per scenario,
                              always
nuka do <step> [--args '<json>'] [--use <step-record-id>]
                              execute one typed step; step record to stdout.
                              --args is required unless --use supplies
                              every key; --use fills its `from` keys
                              from an earlier execution's result
nuka harvest <step-record-id>...
                              turn a `do` sequence into one feature draft on
                              stdout: the lines and their order are measured,
                              the keywords are `*` and the names are
                              placeholders, because a claim is not in a step
                              record. What cannot become a line, what failed
                              when it ran, and what does not read back to the
                              record it came from are named in the draft and
                              on stderr. Provenance goes to stderr only. A
                              `nuka run` record is refused
nuka steps [--json]           list the whole vocabulary, typed and compat:
                              name, patterns, description, mutates, which
                              fixtures each step needs (needs, needs_browser,
                              or needs: null plus needs_error for the one it
                              can't read), and where each chained args key
                              comes from; --json's top level is { steps,
                              import_failures }, the second always present,
                              exiting 1 if either has anything in it, output
                              printed either way
nuka describe <step>          full contract, schemas as JSON Schema, plus
                              rationale when the step declared one, plus
                              import_failures beside it (same shape as nuka
                              steps' own); exits 1 when that array is non-empty
nuka scaffold <name>          typed step template that fails until implemented
nuka check [feature]          static checks: pattern/schema mismatches, Then
                              binding to mutating steps, undefined steps per
                              feature, ambiguous steps (one line two patterns
                              both match), duplicate patterns, a required
                              args key nothing on that line could fill, a
                              required `from` key whose producer is absent,
                              bound later in the scenario, or ambiguous
                              between two producers, a `from` naming a step
                              discovery never registered, a fixture
                              dependency cycle, a process-scope fixture
                              depending on a scenario-scope one, a page
                              override that owns neither page nor context,
                              config coherence, unreadable step files
                              (reported, not fatal, the rest of the project
                              is still checked), a `.cjs` file discovery
                              walks but never imports, a featuresDir scan
                              that found nothing loadable, unsupported hook
                              tag expressions; with no argument, scans
                              featuresDir plus additionalFeatureDirs; a
                              feature argument checks that one file instead,
                              for a feature living outside both
nuka accept <feature>         freeze that feature's last green run as a
                              committed acceptance record beside it
nuka tend [--json]            scans featuresDir plus additionalFeatureDirs,
                              then where the bed is, then what is rotting
                              rather than what is broken: how much of the
                              vocabulary is typed rather than compat, how
                              many typed steps are read-only, and how much
                              of it declares what it could, then a sign-off
                              that no longer matches the code it froze (the
                              one finding that exits non-zero), a step file
                              that failed to import, a `from` nothing
                              exercises, a patterned step no
                              feature binds, a schema field with no
                              `.describe()`, a step with no `rationale`, a
                              configured parameter type no pattern uses, a
                              `defineParameterType` still registered from
                              support code, a secrets entry naming a key no
                              envFile defines, a configured
                              additionalFeatureDirs entry absent from disk,
                              an accepted feature outside every scanned
                              directory, a fixture no typed step requires,
                              a fixture reaching page/context
nuka session list|clear
nuka init [--base-url <url>] [--features-dir <dir>]
                              set up a project; ends with a self-check
nuka skill path               where the bundled skill lives, for a project
                              that wants the copy matching this nukadoko
nuka mcp-tools [--json] -- <command> [args...]
                              list the tools an MCP server declares over stdio,
                              connecting just long enough to ask. A separate
                              face from `nuka steps`; nothing this command
                              reports is ever part of that vocabulary
nuka experimental webmcp-tools <url> [--json]
                              EXPERIMENTAL, may change or disappear without
                              notice: list the WebMCP tools a page has already
                              declared via navigator.modelContext.registerTool.
                              The same separation from `nuka steps` that
                              `mcp-tools` draws, over a different protocol;
                              nested one command under `experimental` on
                              purpose, so the word is unavoidable at the call
                              site
```

Text output (no `--json`) is formatted for a human reading a terminal; `--json` is the machine-readable contract.

### Tolerant reporting, fail-fast execution

A broken step file gets two different responses across this list, and the
split follows one question: is the command about to execute a step, or
only report on the vocabulary. `nuka steps`, `nuka describe`, `nuka check`,
and `nuka tend` are reporting tools: each discovers steps per file, so one
file whose import fails does not empty what the rest of the project could
still show. `nuka check` names the failure as `step-file-import-failed`;
`nuka steps`/`nuka describe` carry the same fact as `import_failures`
(above); `nuka tend` adds a single `import-failures-unseen` note instead of
silently under-counting around the file it never read (see "Tending").
`nuka run`, `nuka do`, and `nuka init` are about to execute a step, or set
up a project that is about to, so they stay fail-fast: the same broken file
rejects the whole call outright, since continuing past it is dangerous for
anything about to run, not merely report on. A migrating suite's normal
state is some glue still broken, and a reporting tool that refused to run
at all in that state would not be a useful migration dashboard; an
execution tool that pressed on anyway would be running against glue it
never actually read.

## Out of scope (honest limits)

- Semantic truth of a step's implementation rests on PR review. The tool
  guarantees the shape of inputs/outputs and the fact of execution.
- nukadoko cannot stop an agent with shell access from reading `.env` directly;
  it removes the structural necessity of secrets passing through the agent's
  context.
- A sign-off is not a proof that the software is correct. It records that an
  agreed scenario was green at one named commit, and says nothing about today.
  It does not even claim that same commit would be green now. A defect that
  depends on when the run happened (a date computed in one timezone and
  read in another, a boundary the clock crosses) is missing from
  the record exactly as it was missing from the run, and nukadoko does not
  re-run a frozen scenario to find out. The honesty is that a record only
  ever speaks about one execution; the limit is that a whole class of defect
  is invisible to any single one.
- **Promoting a step to `defineStep` is one-way.** The migration door's
  promise covers compat assets: switching the import back leaves a plain
  cucumber-js suite. `defineStep` has no import to switch back to. A
  promoted step's body still moves (it is written against Playwright's own
  objects, by the same choice stated below), but its schemas, its step
  record's `result`, `from` and the binding-order check reading it, and every
  contract check built on those do not, and nothing here converts one back.
  Stated as a limit rather than a gap to close: the conversion is per-step
  and mechanical, and the import's reversibility exists to make adoption's
  first step cheap, not to make the typed side optional.
- **Not driver-agnostic, deliberately.** The `page` and `request` fixtures
  return Playwright's own `Page` and `APIRequestContext`, and the compat
  door hands migrating glue the same objects it already used. Wrapping them
  behind an interface of nukadoko's own would cost every capability the
  wrapper didn't think to expose, and would replace a vocabulary users
  already know with one only this tool speaks: the opposite of writing
  through the official SDK. The exchange is that swapping in another driver
  later breaks the public API and the compat door together. That is
  accepted, not overlooked: rewriting step bodies from one driver's API to
  another is work an agent does well, while paying for portability up front
  would slow every change that isn't a driver swap. Revisit when the
  probability of that swap is measured to have risen, not before.
- No test parallelism, sharding, or CI reporting, and no retry that
  discards a prior attempt's record. No outbound
  network I/O by nukadoko itself. No HTML rendering: that is Allure's job.

## Roadmap

- **M1 (engine core)**: `defineStep`, `do`, `run` over pickles, step records,
  sessions/environments, `check`, `init`. Secrets onboarding redesigned.
- **M2 (compat API)**: `nukadoko/compat` (Given/When/Then/World/hooks subset),
  migration guide for cucumber-js + Playwright suites.
- **M3 (reporting interop)**: a cucumber messages (NDJSON) emitter for
  scenario runs (the compatibility surface that keeps a migrating team's
  existing formatters, JUnit-based CI, and HTML reports working), plus the
  allure-results emitter as the flagship dashboard.
- **M4 (sign-off)**: `nuka accept`, the commit and cleanliness checks it
  refuses on, and the frozen record written beside the feature.
- **M5 (skills)**: the skills nukadoko ships, and `nuka skill path`. The
  CLI is deliberately a set of small verbs; a skill is what turns them into
  a workflow an agent can follow without being told, and none of it changes
  the engine. Skills follow the Agent Skills specification, so `gh skill
  install` and a Claude Code plugin marketplace both distribute them across
  hosts; nukadoko does not copy files into any host's directory itself.
  `nuka skill path` exists for the one thing neither of those can offer:
  the skill that shipped with the installed nukadoko, at the version that
  installed it, since a skill describes a CLI and drifts into fiction when
  the two diverge. Two ship. The **acceptance skill** drives the acceptance
  loop end to end: criteria in, vocabulary read with `steps` and
  `describe`, missing operations scaffolded and implemented, the scenario
  written, then `run` until green and `accept`. The **migration skill**
  carries what the compat audit measured: the gaps a real cucumber-js suite
  actually hits, in the order they bite rather than the order they are
  documented. Its first stage leans on `nuka check` reporting those gaps,
  which `nuka check` now does (see "Compat steps").
  Neither writes down a fact the CLI already answers (vocabulary,
  contracts, refusal reasons), because a skill that copies those starts
  lying the moment the command changes.
- **M6 (chained arguments)**: `from`, the scenario-order check `nuka check`
  and `nuka run` share, `--use` on `do`, and a `used` entry that names the
  step beside the step record it cites. Where a step's inputs come from stops
  being prose inside a `run` body and becomes a declaration the tool reads
  (see "Chaining steps").
- **M7 (tending)**: `nuka tend`, the findings that are about rot rather
  than breakage (see "Tending"). Kept off `nuka check` on purpose: `check`
  is read before every run and has to stay worth stopping for.
- **M8 (fixtures)**: user-defined resources declared under
  `nukadoko.config.ts`'s own `fixtures` (see "Fixtures"), `defineFixtures`
  for full typing, scope, `use()`-based teardown carrying the step's or
  scenario's own outcome, a fixture-specific timeout, and the `check`/`tend`
  findings that come with them. Closes the one gap the typed side had that
  compat's After hooks did not: a place to put cleanup that is not itself an
  acceptance condition.
- **M9 (parts)**: `parts` on `defineStep`, the `call` fixture, the `calls`
  entries a step record gains, and the checks that come with them (see
  "Parts"). A step can be split without its feature file being rewritten,
  which is what makes a reuse granularity smaller than a scenario line
  possible at all.
- **M10 (harvesting)**: `nuka harvest`, one feature draft built from a
  named `do` sequence (see "Harvesting"). This is the move that closes the
  adaptive loop: a path found by exploring becomes a path fixed in a
  sentence, which is the only form anything here can gate on.
- **M11 (live sessions)**: `nuka session start`/`stop`, one `ctx` held
  open in a process so `nuka do` can land on a world that is already
  partway through (see "Live sessions"). Everything before this started
  from nothing, which is merely slow for reads and impossible for work
  that cannot be repeated.
- **Later**: AI-assisted glue converter (existing regex glue → typed steps),
  tag-expression filtering, cucumber-js adapter if a real suite needs
  in-place coexistence rather than migration.

## Implementation notes

- Runtime dependencies: `@cucumber/gherkin`,
  `@cucumber/cucumber-expressions`, `@cucumber/messages`,
  `allure-js-commons`, `playwright`, `zod`, `tsx` (runtime TS import),
  `yargs` (CLI). Node >= 20.
- When a format or protocol has an official SDK, nukadoko writes through it
  rather than reimplementing the format (allure-results through
  allure-js-commons' reporter machinery, cucumber messages through
  `@cucumber/messages`) and stays a thin mapping layer on top. Overriding
  a piece of the official machinery is a measured decision taken when a
  concrete need appears, never the default.
- id format: `<kind>-<timestamp>-<short random>`.
- `nuka steps` and `nuka describe` import step modules (collecting compat
  registrations and patterns requires it), and importing executes a file's
  top-level code, the same caution as running. Shell completion never
  imports: typed step names complete from file names, ids and session names
  from the state directory, so TAB stays fast regardless of vocabulary size.
- The first real-world validation gate (before M2 is designed in detail):
  bind ~10 real feature files and measure whether reviewing AI-drafted typed
  steps actually beats writing glue by hand. Run against 11 feature files
  from seven public projects; the answer was yes in six of the seven. The
  second gate measured the compat door rather than the typed one, and is
  reported under Compat steps above.
