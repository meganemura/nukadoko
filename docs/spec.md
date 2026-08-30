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

nukadoko is an agent-first engine that runs Gherkin. Humans write and review
the durable artifacts: feature files, typed step definitions, and sign-off
records. Agents execute those artifacts. The runtime supports an agent's
trial-and-error loop. Every step has a typed contract and can run alone from
the CLI. Every execution leaves a step record that the tool wrote, not the
agent. An agent with shell access can write any file, so it can forge this
record. The distinction is that nobody had to ask the agent to produce the
record (see "Out of scope").

Agent-first is a design constraint, not a slogan. An agent must complete the
whole loop without assistance. It discovers the vocabulary
(`nuka steps --json`), reads a contract (`nuka describe`, with schemas as JSON
Schema), and executes one step (`nuka do`, with a step record on stdout and a
meaningful exit code). It then reads the validated result and decides the next
call. If the vocabulary lacks an operation, the agent scaffolds and implements
a new step. A human reviews the PR. Every interface has a machine-readable
form (`--json`), while Allure provides rich reports for humans.

One consequence of that constraint directs how this tool grows.
End-to-end execution needs a browser, a real target, and minutes of time.
Unit tests do not have these costs. In practice, iteration speed depends on
how much of a scenario can be judged wrong **without running it**. For an
agent, this directly determines how quickly its loop of cheap commands can
correct its work. Each declaration in this spec helps pay that cost.
`pattern` and `args` let `check` reject a line before a browser opens.
`mutates` lets it question a Then. `from` lets it reject a scenario when the
step order can only fail. Expanding what `nuka check` can settle is therefore
a first-class goal, not a convenience. After each failed run, the standing
question is whether a check could have caught the failure first. Honesty sets
the limit. `check` only makes a claim when there is only one possible outcome,
because a check that guesses trains people to ignore reliable checks.

A nukadoko is the fermented rice-bran bed that turns cucumbers into pickles.
It is alive. Daily care makes it mature, while neglect makes it die. This tool
makes the same claim about step definitions. They are a living culture, not a
write-once test asset, and the agent tends them.

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

Two independent forms of rot meet here.

**BDD rot.** In Cucumber, patterns bind step definitions as glue to prose.
The glue library decays without a visible signal. Duplicate steps accumulate,
and undefined steps appear only at run time. Nothing defines the types that a
step consumes or produces. The report can only say "passed" because it has no
record of what was sent or received. Keywords are decoration. Cucumber
executes a Then exactly like a Given, so nothing prevents an assertion step
from mutating state.

**Agent rot.** When an AI agent improvises browser automation for acceptance
checks, it becomes both the executor and the result reporter. The structure
does not prevent the agent from reporting a plausible result without executing
anything. The improvised operations also leave no reviewable artifact.

nukadoko closes both gaps. The operation vocabulary is committed, typed, and
reviewed. The tool owns execution and measures what happened instead of
trusting a person's account.

## Artifacts

Everything nukadoko touches belongs to one of five kinds. The kind depends on
who writes it, whether it belongs in the repository, and its intended lifetime:

| Purpose | Artifact | Written by | Committed | Lifetime | Read by |
|---|---|---|---|---|---|
| Contract | `.feature`, step definitions, `nukadoko.config.ts` | a human | yes | permanent | humans, the engine |
| Measurement | `.nukadoko/records/steps/<id>/` (`record.json` and its evidence), `.nukadoko/records/scenarios/<id>` | the tool | no | until `nuka clean` removes it | `nuka accept`, the Allure and messages emitters, `nuka do --use` |
| Sign-off | `<feature-basename>.<date>-<sha>.<environment>.<browser>.md`, beside the feature | the tool (`nuka accept`) | yes | permanent | humans, PR review, `nuka tend` |
| Export | `.nukadoko/export/allure-results/`, `.nukadoko/export/messages.ndjson` (plus one run-id-suffixed file per `nuka run` invocation beside the latter, until `nuka clean` removes it) | the tool | no | disposable | other tools |
| Cache | `.nukadoko/cache/sessions/` | the tool | no | disposable | `nuka run` / `nuka do` |

The table names files. The distinctions between its columns answer two
questions: "what happens if this is deleted" and "who gets to change it":

- **Export is disposable because it is derived.** Delete it, and the next
  `nuka run` writes a fresh one. It exists for readers outside nukadoko,
  such as Allure's CLI or a CI formatter. Nukadoko never reads it itself.
- **Cache is disposable for a different reason.** It does not record anything
  that happened. It only represents avoided work: a session file lets a later
  call skip another login. Deleting it costs a login but never correctness.
- **Only Contract and Sign-off are committed.** Contract is the promise that
  a human wrote and reviewed. Sign-off is the claim that the tool froze after
  the promise ran green. Measurement is never committed. `nuka init`
  gitignores its state directory because the working record from one run says
  nothing about the next run.
- **Measurement's "one run" lifetime was aspirational until `nuka clean`
  existed.** A run did not remove its step or scenario records when it ended.
  `nuka do --use` and `nuka harvest` intentionally read records from previous
  days, so automatic deletion was never an option. The explicit operation is
  now `nuka clean [--records] [--cache] [--export] [--dry-run] [--json]`.
  With no category flag, it cleans all three categories. One category flag
  limits the operation to that category. `--dry-run` prints the same plan that
  the real run would use, but removes nothing. If any session is live anywhere,
  the command refuses the complete operation for every category. The session
  process can still write records and export output. This rule applies to all
  environments for the same reason that `nuka session clear` refuses a live
  lock. One export file is always exempt. `export/allure-history.jsonl` sits
  beside `allure-results/`, not inside it. It is the only artifact here that a
  new run cannot reproduce.
- **Step records and scenario records share one row.** They differ only in
  grain. A scenario record and each of its step records answer the same
  question at two resolutions, not two different questions. `nuka do` has no
  scenario for which it can write a record, so it writes only a step record.
  "Record" names both types. The file split represents grain, not a second
  concept.

## Typed steps

nukadoko follows Cucumber's layout convention. Feature files and their support
code live together under `features/`. A migrating team can keep its mental
model and directory tree. Typed steps belong in `features/steps/`, with one
step per file: `features/steps/<name>.ts`. The file uses kebab-case, and its
name is the step name.

Discovery walks `featuresDir` for each `.ts`, `.mts`, `.js`, and `.mjs` file.
The step name omits the file's extension. At every depth, discovery skips
`node_modules` and dot-directories such as `.git`, `.nukadoko`, and `.vscode`.
It also excludes `.d.ts` and `.d.mts` type declarations because they are not
step definitions.

Discovery identifies each `.cjs` file but never imports it. nukadoko is
ESM-only. See "Compat steps" below for the same CommonJS decision. `nuka check`
reports the file as `step-file-unsupported-extension`. This report prevents its
definitions from resurfacing as unexplained `undefined-step` findings.

A wide `featuresDir`, such as a repository root, widens the same walk. A build
artifact anywhere in that tree can become glue when its name has one of the
four supported extensions. `node_modules` and all dot-directories remain
excluded for every `featuresDir` setting.

A wider setting changes what `nuka check` does, not only what it finds.
Discovery imports every file that it walks. Thus, a module can read an
environment, open a connection, or write a file during an otherwise read-only
command. If `featuresDir` contains the application and the glue, discovery
executes the application's top-level code.

```ts
import { defineStep, z } from "nukadoko";

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
- The capture-stripping-and-matching pipeline above is also exported on its
  own, as `nukadoko/matching`'s `resolveStaticPattern`: given one pattern
  (`kind: "typed"` or `"compat"`, string or RegExp), it returns either a
  plain text-match predicate or a traceable `ok: false` reason, never a
  silent `false`. It calls the exact matching machinery `nuka run` already
  builds, not a second implementation, so a caller outside this package (an
  editor resolving which step a Gherkin line binds to, for instance) and
  `nuka run` itself can never disagree about what a pattern matches.
  Resolution uses built-in parameter types only: a workspace's own
  `config.parameterTypes` or compat `defineParameterType` calls need that
  workspace's code running to resolve, out of scope for a purely static
  caller.
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
- An args key the pattern, a table/docstring, or `from` did not fill and
  the schema does not declare is refused, not silently dropped: `nuka
  describe` already publishes each object `args` schema's own
  `additionalProperties: false`, and every path that turns a step's `args`
  into a validated value now parses against that same closed shape (`nuka
  do`, `nuka do --session <live>`, `nuka run`, `recordStep`,
  and the `call` fixture a part is invoked through, see "Parts"). A key
  `from`/`--use` fills is never flagged, since either can only ever name a
  key the step itself declared. A successful record's own `args` is the
  validated value, so a key a schema's own `.default(...)` filled in shows
  up even when nothing on the line typed it; a failed record keeps exactly
  what was given, which is where a reader needs the raw thing most. A
  part's own `CallEntry.args` (see "Records") stays raw on both outcomes
  regardless: what changed here is what gets accepted, not what gets
  written down.
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

A step's `run` takes a **fixture bag** in a plain destructuring pattern:
`run({ page, section }, args)`. Names use alphabetical order. The executor
builds only the fixtures that the step destructures. If the step names neither
`page` nor `context`, the executor does not launch a browser for that step.

The browser behavior is a consequence of the main design goal.
`run({ page }, args)` does not mean "give me the page." The object pattern is
a static declaration that `check` parses without calling `run`. It already
parses `pattern`, `args`, `returns`, and `from` without execution.

Thus, a step declares `page` when the author writes the file. The step does not
request it through an action at run time. `check` parses the source text of
`run`, and the executor builds fixtures from the same declaration. The static
check and execution therefore use one source of information.

`from` established this design for a step's output (see "Chaining steps"). A
static declaration controls execution instead of describing it later. The
fixture bag applies the same design to a resource.

Playwright fixtures use the same destructuring syntax, but this similarity did
not determine the design. For Playwright, the pattern tells its runner what to
construct. For nukadoko, the pattern first gives `check` a declaration. It
becomes a construction instruction as a consequence.

The fixture names:

- `page: Page`: a Playwright Page restored from the session's storageState.
  The configured baseURL is wired into the browser context, so
  `page.goto("/path")` resolves against it. The standard URL rule applies: a
  leading slash replaces baseURL's own path instead of appending to it.
  This behavior was measured with Playwright 1.61.1 and `baseURL:
  "https://demo.playwright.dev/todomvc/"`. `goto("/")` lands on
  `https://demo.playwright.dev/`, the host's own root. It does not land on
  the app under `/todomvc/`. Both `goto("./")` and the absolute
  `goto("/todomvc/")` land on `https://demo.playwright.dev/todomvc/#/`.
  A suite whose app lives under a path uses one of those two forms for its
  first navigation. It never uses a bare leading slash there. The browser
  launches when the step's own bag is built. It launches only when `page`
  or `context` (below) is one of the names the step destructured. It never
  launches earlier or for a step that names neither fixture.
- `context: BrowserContext`: the `BrowserContext` that `page` already belongs
  to (`page.context()`). It is never a second context. It lets a step open a
  second tab with `context.newPage()`. The step does not need the `browser`
  that the executor does not expose (below).
- `request: APIRequestContext`: a Playwright APIRequestContext with the
  session's cookies. As with `page` above, `baseURL` is optional. A suite that
  calls only absolute URLs across multiple hosts has no single baseURL to
  state. Nukadoko does not force one into config only to satisfy this fixture.
  If `baseURL` is unset and a step passes a relative path, Playwright produces
  the failure. Nukadoko does not re-implement Playwright's URL resolution to
  prevent that failure first.
- `env`: read-only environment variables from the configured envFiles. This
  fixture enforces determinism: the process environment is never merged. It
  also enforces secrets redaction: only values that nukadoko loaded are
  redactable. It is not a convenience.
- `requireEnv(name)`: returns the same value as `env[name]`. It provides the
  presence check that each step reading a required variable would otherwise
  write. It returns `string`, never `undefined`, because it throws when the
  value is missing. An empty string also counts as missing. An envFile line of
  `KEY=` parses to `""`, not to "key omitted." A step that declares the
  variable as required is equally broken in both cases. The error names only
  the key, never a value. A missing value gives it no value to show. A form
  that never carries values cannot later become a redaction gap. The error
  cannot identify which envFile to fix. This fixture sees only the merged
  result, never the `config.envFiles` list. `env` remains available for the
  rare step that needs every key at once. Every name passed to `requireEnv` is
  recorded in the step record's `required_env` (see "Records"). This happens
  whether the call finds a value or throws. The names use read order and are
  deduplicated. Reading the same value directly from `env` leaves no trace.
  That path is a plain object, so the library never sees the read.
- `baseURL`: the configured baseURL for the occasional URL assembled by hand.
  The common paths receive it as described above. It is `undefined` when
  `config.baseURL` is unset. This is valid for a suite that uses only absolute
  URLs. It is not an error state.
- `resultOf(stepModule)`: returns the validated result from that step's most
  recent successful execution in the current scenario. It returns `undefined`
  under `nuka do` or when the step has not succeeded yet. This is the scenario
  path's data channel. It is deliberately not a World. Nothing can write to
  it. Code can read only results that passed their `returns` schema. The
  dependency is a visible `import` of the other step module. That step's own
  schema types the dependency, and the diff exposes it for review. A feature
  line such as "that listing is closed" is implementable exactly when its
  referent produced a validated result. `from` (see "Chaining steps") is the
  declarative form of the same read. Use it first. `resultOf` remains for reads
  that a key name cannot express. Passing a `Step` that discovery never
  registered throws instead of returning `undefined`. See "Chaining steps"
  for the mistake that this rule catches.
- `await call(stepModule, args)`: runs one of this step's declared `parts` and
  returns its validated result (see "Parts"). The part's own `args` schema
  validates the args. Its `returns` schema validates the result. The call is
  recorded under `calls` on this step's own step record. A step that `parts`
  does not declare throws instead of running. A step that discovery never
  registered also throws instead of running.
- `section(label: string): void`: marks that execution reached a named stage.
  It is synchronous and has no return value. It has no matching "end" call.
  Every call is appended to the step record's `sections` in call order (see
  "Records"). A step that never calls it has no `sections` key. This is the
  same convention that `used` follows. It is intentionally a bare marker, not
  a function that wraps a block (`section(label, fn)`). A wrapper would have
  to define the meaning of nesting, an early `return`, and an `await` that
  crosses its boundary. Those definitions are not required for the question
  that this fixture answers. It records where execution stopped, not the
  shape of the block that stopped.
- `await poll(fn, { description, timeout, interval })`: the submit-poll-fetch
  loop for a requested state that does not exist yet. `fn` returns `undefined`
  until the state exists. `poll` returns the first defined value. If the
  `timeout` budget ends first, `poll` throws `PollTimeoutError`. Every completed
  call is stored in the step record's `polls` (see "Records"). The record shows
  the attempt count, the wait duration, and the outcome. The value that `fn`
  polls for is a contract choice, not an implementation detail. It cannot be
  the observed target's own presence. A target whose correct passing state is
  absence would then be indistinguishable from one that has not rendered yet.
  Polling for presence would prevent `fn` from returning the answer that the
  step must give. Instead, poll for the condition that makes a verdict about
  the target possible. Examples include a loading flag becoming false, a
  count becoming defined, or anything the page always renders after its data
  arrives. Read the target only after that condition resolves. A direct browser
  wait through `page.waitForSelector` or `waitForLoadState` waits in the same
  way, but it leaves no record. Using `poll` adds `at`, `attempts`, `waited_ms`,
  and `outcome` to the step record. These fields provide the only way to
  distinguish "resolved on the first attempt, the wait did nothing" from
  "resolved four seconds in" after the event. This is the same boundary between
  self-reporting and measurement that the Allure emitter marks with its
  `declared:` prefix (see "Allure emitter"). Here, that boundary separates a
  wait that the tool measured from one that occurred invisibly in Playwright.
- `evidence.attach(name, body)` / `evidence.path(name)`: fills the one gap that
  the other fixtures do not cover. Every other fixture above returns something
  that the harness collects by itself. Previously, no fixture accepted
  application-specific evidence that only a step can produce. Examples include
  an API response body, a DB snapshot, and a generated file's contents.
  `attach` writes `body` (`string | Uint8Array`) into this execution's own
  evidence directory. It records the file in the step record's
  `evidence.attachments` (see "Records"). Two calls with the same `name` keep
  both files and never overwrite the first file. `path` is Playwright's own
  `testInfo.outputPath()`. It allocates a collision-free absolute path under
  the same directory without writing anything. The step record lists only a
  path that a step wrote to before execution ended. A call to `path()` without
  a later write adds nothing. Both methods are on one object because they need
  the same information from the executor: the directory for this step's own
  evidence. A step needs one method about as often as it needs the other. A
  `name` that contains a path separator is refused. A `name` equal to `.`,
  `..`, or the empty string is also refused. Nukadoko never silently rewrites
  these names. A loud error at the call is better than letting a step trust a
  name that it did not request.

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
from "playwright/test"`. Whether a matcher asserts exactly as it would in
a Playwright test does not follow from what it is called on:
`toMatchAriaSnapshot` (a locator), `toHaveScreenshot` (`page`), and
`toMatchSnapshot` (a plain value) each throw `"<name>() must be called
during the test"` outside the runner (measured against Playwright 1.61.1),
the same three shapes `toBeVisible`, `toBe`, and `expect.poll` take
without incident. What decides it is whether the matcher reads or writes a
snapshot file keyed to the runner's current test, and a step has none.
This follows from the same rule every other fixture answers to: a
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

The fixture bag in "Context API" is closed.
It contains only `page`, `context`, `request`, `env`, `requireEnv`, `baseURL`,
`resultOf`, `call`, `section`, `poll`, and `evidence`.
A step can also need a project resource, such as a tenant, a seeded database,
or an uploaded fixture file.
Previously, the step had no suitable place for the cleanup code.
Cleanup inside the step adds something that is not an acceptance condition to
the feature file.
Omitted cleanup leaks the resource.
`nukadoko.config.ts` provides the required place:

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

A fixture is a bare function or a `[function, options]` tuple.
Playwright fixture definitions use these two shapes too.
Therefore, `base.extend()` accepts an unchanged fixture when all its
dependencies are `page`, `context`, `request`, or `baseURL`.
This shared subset describes the definition shape only.
It is not a broader compatibility promise.
Playwright's runner does not understand a fixture that destructures `env`,
`section`, `poll`, `resultOf`, `call`, `evidence`, or another nukadoko-only name.
nukadoko also refuses `auto: true` and explains the reason in its message.
That option lets Playwright build a fixture that no consumer requested.
The feature file must name everything that ran, so nukadoko cannot build an
unrequested fixture.
This package claims only that it accepts the same definition shape.
It does not claim broader Playwright fixture compatibility.

Do not put one shared `fixtures.ts` behind both runners.
TypeScript applies contextual typing only to an inline object literal.
A fixture map in a plain `export const` loses that typing and fails under
`strict`.
For nukadoko, pass the same object literal through `defineFixtures` from the
`nukadoko` package.
TypeScript then treats the object literal as inline.
Both `request` and `use` get full types without manual annotations.
A dependency on another user-defined fixture still has the type `unknown`.
Its declared type would require self-referencing inference.
This package does not implement that inference because it only worked through
an undocumented compiler behavior during measurement.

A fixture destructures its first argument in the same way as a step.
`check` reads the fixture dependency names from the source text without
calling the fixture.
It reads step dependencies in the same way.
A fixture can name a builtin dependency: `page`, `context`, `request`, `env`,
`requireEnv`, or `baseURL`.
A fixture can also name another `config.fixtures` entry.
Resolution follows Playwright's `extend()` model, so later layers can depend
on earlier layers.
Thus, a fixture can depend on another fixture, which can depend on a builtin.

A fixture can override a builtin.
For example, a `page` fixture can wrap the page that the executor launches:
(`page: async ({ page }, use) => { page.setDefaultTimeout(10_000); await
use(page); }`).
In this case, the dependency `page` refers to the underlying builtin.
It does not refer to the overriding fixture, so this dependency is not a cycle.
An override that destructures neither `page` nor `context` cannot return a
page that the executor still owns and measures.
Therefore, `check` refuses it with `page-override-unowned`.

Two scopes exist.
The default `scenario` scope rebuilds a fixture for each scenario or each
`nuka do` execution.
It tears the fixture down at the end of that scenario or execution.
The `process` scope builds a fixture when a step first names it during a
`nuka run` invocation.
The step can name it directly or through another fixture.
nukadoko tears it down after every scenario in that process finishes.
At the default concurrency of 1, that process runs the whole invocation.

The `worker` scope does not exist because a worker is a process.
`nuka run --concurrency <n>` runs scenarios in `n` worker processes, so
`process` already names one worker.
Under `nuka do`, one execution contains both complete lifetimes.
Therefore, a `process` fixture behaves like a `scenario` fixture in that command.

A `process` fixture can depend only on other `process` fixtures and three
builtins: `env`, `requireEnv`, and `baseURL`.
The values of these builtins do not depend on a scenario context.
`fixture-scope-violation` refuses a dependency on `page`, `context`, `request`,
`resultOf`, `call`, `section`, `poll`, `evidence`, or a `scenario` fixture.
A `process` fixture can outlive the scenario that would supply any of these values.

`process` names one address space.
It does not name one `nuka run` invocation.
A fixture value is a plain JavaScript object and cannot cross into another process.
Thus, this scope always means "once per process."
A `nuka run --concurrency <n>` invocation uses `n` processes, so it builds the
fixture `n` times.
The two lifetimes coincide only at the default concurrency of 1.
Do not use a `process` fixture for an action that must occur exactly once in the world.
Examples include a database seed, a migration, or a mock server that owns a port.
Each additional process performs the action again.

Teardown uses the reverse build order, whether the step passes or fails.
A step failure does not make fixture cleanup optional.
This reverse order is correct because nukadoko builds and tears down fixtures
*serially* within one process.
The reverse order makes each dependency outlive its dependents.
`nuka run --concurrency <n>` keeps this rule.
Each worker is a process that runs its own scenarios in order, and a worker
never sees another worker's fixtures.
Therefore no scenario can tear down a dependency that another scenario still uses.
This rule is one reason nukadoko runs scenarios in worker processes rather than
concurrently inside one process.
Concurrency inside one process breaks the rule by timing, rather than by fixture
graph shape, and `check` cannot see timing.

Setup cannot know the outcome of the step that named the fixture.
For `process` scope, setup cannot know the outcome of the run.
Therefore, the fixture function does not receive the outcome as a second argument.
Instead, `use()` returns the outcome:

```ts
tenant: async ({ request }, use) => {
  const t = await createTenant(request);
  const outcome = await use(t);          // "passed" | "failed"
  if (outcome === "passed") await destroyTenant(request, t);
},
```

QA work commonly keeps a failed tenant for inspection and destroys a passed tenant.
Playwright's `afterEach` reads `testInfo.status` for the same reason.
A teardown failure does not change the step or scenario status.
A cleanup error cannot fail an otherwise successful run for a reason outside
its acceptance criteria.
However, nukadoko always reports the teardown failure.
A `scenario` fixture failure appears in the scenario record's `teardown_errors`.
A `process` fixture failure appears on stderr after all scenarios finish.
No single scenario record can contain that process-level failure.
`nuka run` and `nuka do` announce either type of failure, but the exit code stays unchanged.

A fixture must call `use(value)` exactly once.
If the function settles before this call, nukadoko throws an error that names the fixture.
If the function calls it twice, nukadoko throws an error at the second call and names the fixture.
These checks address a condition that did not exist for `ctx.page()`.
A fixture is a coroutine that nukadoko suspends at `use()` and resumes during teardown.
Without the first check, a fixture that never reaches `use()` could block the run forever.

Setup and teardown each receive a separate timeout budget.
`config.fixtureTimeout` sets the default budget to 60 seconds.
A fixture can override it through `options.timeout`.
A timeout report names both the fixture and the phase.

`check` reports three fixture findings without running a fixture.
`fixture-cycle` identifies a dependency cycle among `config.fixtures` entries.
`fixture-scope-violation` identifies a `process` fixture that depends on a
`scenario` fixture.
`page-override-unowned` identifies the invalid `page` override described above.

`tend` adds two factual reports.
`fixture-unused` identifies a `config.fixtures` entry that no typed step requires,
directly or through another fixture.
The entry can still be reached through `nuka do`.
`fixture-touches-app` identifies a fixture that reaches `page` or `context`,
directly or through another fixture.
A browser fixture can create an unnamed precondition that lets a scenario pass.
For example, it can log in a user before any step requests a login.
This has the same effect as work that a step's Given does not describe.
The report does not prohibit browser access from a fixture.
For example, a fixture can legitimately generate `storageState`.
`tend` only identifies the fixtures, so a reader decides whether each one belongs.

A step record contains `fixtures` only when the list is not empty.
The list contains every `config.fixtures` entry that fixture resolution touched
for that execution.
Each entry has `{ "name", "scope", "setup_ms"?, "at"?, "reused" }`.
`setup_ms` and `at` appear only when this call built the fixture instance.
Their absence on a `reused: true` entry means that the instance already existed.
This distinction separates reuse from a measured setup time of zero milliseconds.

In `nuka steps --json`, `needs` and `needs_browser` include transitive fixture
dependencies, as described in "Context API."
For example, a step can destructure only a fixture that reaches `page`.
Its `needs` array names only that fixture, but it still has `needs_browser: true`.
A step with `needs: null` has no dependency list to expand.
Therefore, that entry also has no `needs_browser`.
It can still contain `needs_inferred`, as described in "Context API."
That field is a lexical estimate, rather than a contract.
nukadoko does not expand `needs_inferred` through the fixture graph.

### MCP servers

Two interfaces reach a standard MCP server over stdio.
Both interfaces stay separate from `nuka steps`.
`nuka mcp-tools -- <command> [args...]` reads and prints the tools that a server declares.
`connectMcpServer` and `callMcpTool` from `"nukadoko/mcp"` let a hand-written step call a tool.
The declared tools help a person write the step's `args` by hand.
This package does not convert a declared tool into a step or step vocabulary.
`nuka steps` does not list MCP tools, and these interfaces do not generate them.

A fixture controls the server process lifetime.
`nukadoko.config.ts` has no MCP-specific field.
The fixture mechanism already provides setup, teardown, and a `scenario` or
`process` scope.
A fixture calls `connectMcpServer` during setup and `client.close()` during teardown.
Its scope selects one connection per scenario or one connection per run.
Two simultaneous servers use two fixtures, with no change to the mechanism.

`connectMcpServer` accepts the client package's stdio parameters without changes.
It can also accept the package's `ClientOptions` as its second argument.
It returns the connected `Client` from that package.
This thin interface follows the choice that `ctx.page()` and `ctx.request()`
make for Playwright.

The `versionNegotiation` field in `ClientOptions` selects the MCP protocol era.
When the caller omits it, the client package uses its default behavior.
That behavior uses the plain 2025 connection sequence, without a probe or new headers.
The mode `{ versionNegotiation: { mode: 'auto' } }` first sends a `server/discover` probe.
If the server does not report a modern revision, the client uses the 2025 sequence.
For stdio, each probe starts one additional short-lived sibling process per connection.
The client discards that process after it determines the protocol era.
Thus, each fixture setup in `'auto'` mode starts one additional process.

A pinned mode, `{ mode: { pin: '<version>' } }`, does not use the fallback.
It fails when the server does not offer the specified revision.
`connectMcpServer` passes `ClientOptions` directly to the `Client` constructor.
It does not read or override the options, so the caller selects the protocol era.

`callMcpTool` adds one behavior to the direct interface.
MCP returns an in-band tool failure as a successful response with `isError: true`.
It does not reject the promise for that failure.
Without a check, a step could record the failed call as a passing call.
`callMcpTool` throws when `isError` is true and returns all other result fields unchanged.

### WebMCP tools (experimental)

A third interface reads declared tools and keeps them separate from `nuka steps`.
The "MCP servers" interface makes the same separation for a stdio server.
WebMCP uses a different protocol and interface.
It is a browser standard in which a page declares tools from its JavaScript
through `navigator.modelContext.registerTool`.
The project does not open a separate connection for these tools.

`nuka experimental webmcp-tools <url>` starts a new configured browser and
navigates to `url`.
It does not restore a session or collect evidence.
It reads the tools that the page has already declared and prints a report.
The report does not become step vocabulary.
`nuka steps` does not read this interface, and this interface does not read step discovery.
This separation prevents a page from selecting part of the project's step vocabulary.
That fixed vocabulary protects acceptance criteria from a generated implementation.

A hand-written typed step can import `experimental_callWebmcpTool` from
`"nukadoko"` and call an already-declared tool by name.

`experimental_callWebmcpTool` is a plain import, rather than a fixture bag member.
The executor injects only the values that a fixture must carry.
This function needs only `page`, which the step already receives as a fixture.

`poll` moved from an import to the fixture bag for a different reason.
Without a record, a completed wait looks like a successful first attempt in a step record.
The `poll` fixture closes that measurement gap.
A WebMCP tool call has no equivalent gap.
Its typed step declares `args` and `returns` schemas.
The run boundary validates those schemas, regardless of how the step produced the value.
The step record therefore contains the returned value without extra records from this function.

A WebMCP tool call crosses a trust boundary.
The page is the system under test and is not a trusted party.
The page declares the code that receives `args`; this project does not provide that code.
`args` enters the page as JSON, and the page's JavaScript reads it.
For example, a step can read a sensitive value through `ctx.requireEnv`.
If it puts that value in `args`, it gives the value to the page under test.
Do not pass a sensitive value through `experimental_callWebmcpTool`.

Both interfaces show the experimental mark in their names, rather than through a runtime flag.
The function uses the `experimental_` prefix.
The prefix remains visible when autocomplete offers the function to a step author.
The CLI places `experimental` one command above `webmcp-tools`.
A caller must type the mark to use either interface.

This naming differs from the "MCP servers" interface.
`nuka mcp-tools` stays a top-level command because MCP names the primary protocol.
WebMCP is an auxiliary protocol, so its command has one additional level.
Thus, each WebMCP CLI call includes `experimental`.

The mark remains because the standard documentation does not clearly support this use.
The Chrome WebMCP documentation was fetched on 2026-08-13 from
https://developer.chrome.com/docs/ai/webmcp.
It says that headless use might work, but the API primarily targets local
browser workflows with human participation.
It also says that the standard remains under active discussion and can change.

The Japanese page fetched that day makes a stronger statement than the English page.
It says that JavaScript tool calls require an open browser tab or webview for a visible interface.
It therefore describes headless calls from an agent or auxiliary tool as unsupported.
`experimental_callWebmcpTool` makes that type of call from Node through Playwright.
The two localized pages disagreed about support on the same day.
This disagreement makes an unmarked dependency unsafe.
Tests confirm that the interface works with Chromium 149 today.
That measurement does not guarantee continued operation.

The function and command lose the experimental mark only after two conditions hold.
First, the official documentation must explicitly support calls from an auxiliary or headless caller.
Second, it must stop describing the standard as subject to change.
The removal of one sentence does not satisfy either condition by itself.
The localized pages already show that an omitted sentence does not identify the current claim.

### Chaining steps

A CLI-only step has no `pattern` and runs independently.
Adding a `pattern` binds it to a scenario and introduces a new question.
The step needs a way to receive a value from an earlier step.

Reading every value through `resultOf` would remove the command-line argument.
The step could then lose its independent `nuka do` execution.
That execution makes the vocabulary useful to an agent.
A composite step would preserve the existing steps but hide their work behind one Given line.
The feature file would no longer show that work to a reviewer.

`from` preserves both properties by declaring the source of a key as data:

```ts
import { defineStep, z } from "nukadoko";
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

A pattern capture has priority over `from`.
`from` supplies only the keys that this step occurrence did not capture.
Thus, one scenario can provide a value in the Gherkin line.
Another scenario can provide the same value from an earlier step.
`from` uses the most recent successful result from that step in the current scenario.
This result has the same lifetime as `resultOf` because both use the same chain.
nukadoko injects the value before it validates `args`.
Therefore, the key stays **required**, and `args` continues to describe the step requirement.
It does not describe how one caller supplies the value.

A key can name more than one possible producer.
For example, a scenario can create or import a project.
The consumer does not need two steps to support these sources:

```ts
from: { projectId: [[createProject, "id"], [importProject, "projectId"]] }
```

Alternative producers have no priority.
There is no first-match rule, declaration order, or cross-step recency rule.
Instead, the check requires **exactly one** listed producer earlier in the scenario.
Zero producers cause the existing missing-producer error.
Two or more producers also cause an error.
nukadoko refuses a scenario that would depend on a rule hidden from its reader.
The feature file identifies the producer for each occurrence.
The step does not supply a default producer.

Repeated occurrences of one producer follow a different rule.
If `Given a project is created` occurs twice before a consumer, the consumer uses the latest result.
Both occurrences have the same contract, so only result freshness differs.
Two different producers have different contracts and create a provenance choice.
Recency provides a suitable default for freshness, but not for provenance.

Alternative producers are mutually exclusive, so exactly one must run.
A scenario can instead exercise both producers and compare two paths to one record.
In that case, give each producer a separate key:

```ts
from: {
  createdId:  [createProject, "id"],
  importedId: [importProject, "id"],
}
```

Both keys bind and both values are read without competition.
If two producers run in one scenario, one consumer key cannot represent both values.
The consumer must declare two keys for the two values.

`from` uses a key name instead of a selector function because a name is data.
`nuka steps --json` and `nuka describe` retain it as "`projectId` ← `createProject.id`".
An agent can use that data to assemble an order that it did not receive.
`nuka check` also uses the data to evaluate a scenario before execution.
A function could express more behavior, but the tool could report only the source step.
It could not report the selected part of that result.
This design requires a `returns` shape that a key can address.
That small cost also makes steps easier to read.

A `from` declaration enables a certain static check.
For each step occurrence, `nuka check` first checks whether the Gherkin line captures each declared key.
If the line does not capture a key, it checks for an earlier producer in the same pickle.
The pickle includes its Background steps.
`nuka run` performs the same check before it executes the scenario.
Thus, an omitted `nuka check` does not waste a browser session.

A **required** key without an earlier producer is an error.
The run would certainly fail `args` validation, so this check creates no false positive.
An **optional** key without a producer causes no finding because the schema permits its absence.
A warning in that case would report a valid contract as a problem.
Two or more earlier producers cause an error for both required and optional keys.
An optional schema permits absence, but it does not select between multiple producers.
Before `from`, a consumer before its producer looked valid until browser execution exposed the error.

`from` and `resultOf` identify an upstream step by its `Step` object, rather than by name.
A step loaded through `await import()` is a different instance from the registered discovery instance.
Therefore, that object does not match the registered step.
Previously, `resultOf` returned `undefined` indefinitely for this mistake.
Now, an unregistered `Step` causes an error at the point where nukadoko finds it.
Because `from` declares the object statically, `nuka check` reports it.
`nuka run` and `nuka do` also refuse to execute that step.
Because `resultOf` selects the object at runtime, it throws at the call.
A registered step that has not run still returns `undefined`, which represents its current state.

Use `resultOf` when `from` cannot express the required read.
These cases include value reshaping, a runtime decision to read, and use of a complete result.
If the step must also run independently, keep the argument optional and add a fallback inside `run`.
This older form is now the exception.

`nuka do` has no scenario and therefore no chain.
A `from` key can arrive through `--args`, like any other argument.
It can also come from an earlier execution's step record through `--use` (see "Single steps").
Both paths use the same step contract and differ only in the value source.

`from` does not run the upstream step.
If the scenario lacks a producer, fix the feature file.
nukadoko cannot insert the producer because the feature must name everything that ran.
Otherwise, the feature would no longer provide the required execution record.

This rule can produce a scenario line that only transfers an identifier.
For example, `And the project's billing page is fetched` might have no value for the feature reader.
An operation without reader value should not be a step.
Place it in `features/steps/lib/` as an ordinary function when it has no contract.
Make it a part when it has a contract, as the next section explains.
For each case, the step author balances record detail against feature readability.

Chaining connects declaration and measurement differently from `mutates` (see "Keyword semantics").
For `mutates`, the HTTP method is only a proxy for write semantics.
Therefore, the tool records the declaration and measurement without reconciling them.
For chaining, nukadoko knows the exact step record that supplied a value.
`from` controls execution, so its declaration cannot differ from the executed source step.
Therefore, this case requires no reconciliation.
The `used` field in the step record does not check the declaration (see "Records").
The declaration identifies the source step when the author writes the file.
`used` identifies the specific source execution at runtime.

### Parts

A step uses the granularity at which a reader understands the scenario.
Other code rarely needs that same granularity for reuse. This mismatch
usually appears in one of two forms when a second scenario arrives. A
correct step can be too specific. Generalizing it adds an `args` key that
the pattern captures, and the contract checks already cover this change.
Alternatively, a step can perform two operations when the new scenario
needs only one. The required operation has no name, contract, or callable
interface.

Splitting the step and rewriting the first scenario would change an
agreed record. The people who decide the purpose of the software agreed
to that feature, and the feature may already have a sign-off. An
implementation refactor must preserve the agreed sentence.

A step may call another step instead. `parts` declares which ones, and
the `call` fixture runs one:

```ts
import { defineStep, z } from "nukadoko";
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

A part is not a second kind of unit. It is a `Step` that uses the same
`defineStep`, and another step makes it a part by declaring it. A part
that exists only for calls omits `pattern`. It remains part of the
existing CLI-only vocabulary. `nuka do create-project` runs it alone,
and `nuka steps` lists it. The part is therefore accessible and readable
before a scenario names it. Adding a `pattern` later binds the part to a
scenario line and preserves existing calls to it. The second scenario
can use the finer granularity without changing the first feature file.
Both granularities coexist.

`parts` must be declared because the executor builds the fixture bag
before it calls `run()`. The executor statically reads the names that the
first parameter destructures. A part destructures its names from the same
bag. Therefore, a caller needs `page` in its bag when one of its parts
uses `page`. The executor makes this decision before either function
runs. A parser that inspected `call` sites would have to guess the control
flow. It could miss a call inside a branch. A declaration makes the
answer data. A step needs its own fixture names and the fixture names of
all transitively declared parts. User-defined fixtures already close
their needs in the same way (see "Fixtures"). This rule has a visible
cost. A composite step opens a browser when any part uses `page`, even if
the run does not take the branch that calls that part. The rule prevents
a browser from opening partway through a step because of a decision that
was unavailable before execution.

As with `from`, a name is data. `nuka steps --json` and `nuka describe`
retain `parts`. An agent can see that one step contains two other steps
without opening a file. `nuka check` can inspect the same declaration
before execution. `call` refuses a step that `parts` does not declare.
It also refuses a step that discovery did not register. `resultOf`
already rejects the latter error. A second `await import()` creates an
object that the registered vocabulary cannot match. These checks keep
the declaration accurate.

The calling step records each call under `calls` in its own step record.
A call does not create a separate step record. The scenario record keeps
one `steps[]` entry for each feature line. A part adds detail below that
line, while the feature continues to name everything that ran. Each call
entry contains the part name, its args, its result, and its start and end
times. A failed entry also contains an error with the same classification
as a step record's `error`. The executor checks a part's `args` and
`returns` exactly as it checks any other step. Calls from one part to
another use the same nested structure.

Measurements at the step boundary do not split. `observed`, `sections`,
`used`, `required_env`, the evidence directory, and the trace chunk
belong to the calling step. Their totals include work from all parts. A
part also shares its caller's `ctx`. The record describes one execution
in more detail. The single total prevents duplicate counts and includes
work that ran inside a part.

`call` does not consult `from`. The caller supplies every key, as
`nuka do` does. A chain belongs to a scenario, but a call does not. When
a part also runs as a scenario line, that occurrence uses its `from`.
One caller's inputs do not affect other callers.

`nuka check` reports two definite errors. First, a cycle in `parts` lets
a step reach itself. Such a cycle cannot produce a closed fixture bag or
a terminating run. Second, a step cannot declare `mutates: false` when a
declared part has `mutates: true`. `mutates` covers state changes anywhere
the step can reach, including its parts. This check keeps `then-mutates`
local. A `Then` line still reads one flag on one step because that flag
already accounts for all parts.

No check reports a declared part that the body never calls. `run` contains
the call, while the declaration names a `Step` object. It does not name
the identifier that the body binds to that object. A check would therefore
have to guess whether the names correspond. The body can also call a part
only in one branch. An unused `from` key is different because the feature
files contain enough information to decide it. `nuka tend` reports that
case. The available static data cannot decide whether a part is unused.

The contradiction check does not enforce the read-only policy. In a
read-only environment, `call` refuses a `mutates: true` part before it
runs. The caller's declaration does not change this refusal. The static
check finds the contradiction earlier and at lower cost. The run-time
refusal protects execution when no static check ran. Both controls trust
the part's declaration.

Choose among a helper, a part, and a step by extending the axis from
"Chaining steps." If an operation has meaning to a scenario reader, make
it a step. The acceptance record then includes its step record. Otherwise,
consider what a failure record must show. Use a part when the operation
has a useful contract, useful inputs, and a useful result. Use an ordinary
function under `features/steps/lib/` when it has none of these. A helper
has no separate record entry. Its HTTP calls still contribute to the
calling step's `observed`, and `section` can show its execution progress.
For example, a function that formats a payload or selects a fixture file
usually has no useful contract or result to preserve. Making it a part
would add only a schema to maintain.

One alternative was rejected. A step file could use named exports for
several steps. This design would keep split operations beside the
composite step. However, typed step names complete from file names without
imports (see "Implementation notes"). This property keeps TAB fast as the
vocabulary grows. The CLI cannot see a named export without importing its
file. A separate file for each part preserves fast completion and adds one
file.

### Keyword semantics

Gherkin keywords carry a fact because nukadoko trusts the **`mutates`
declaration**. The tool does not derive this fact again from execution or
override a conflicting declaration. Real suites require the following
layers. The same sentence can appear correctly in both Action and Outcome
positions. Suites often use `And` to chain actions after `Then`. A step
that wraps an arbitrary command cannot have one accurate `mutates` value
for every occurrence. Therefore, a per-step Boolean cannot describe a
per-occurrence fact:

- `mutates` states the step's **declared intent**. Its default is `true`,
  and read-only steps declare `false`.
- **During static analysis**, `nuka check` warns when a declared-mutating
  step is bound in Then position. It does not report an error. A person
  must review the conflict because the declaration alone cannot resolve it.
- **Read-only environments refuse a declared-mutating step before it
  runs.** This rule includes a part reached through `call` (see "Parts").
  This is the only place where the declaration gates execution.
- **At run time**, the step record stores what the execution did. It stores
  every network call that the tool observed through the `request` fixture
  or the page. It counts non-GET/HEAD calls as observed writes beside the
  declared `mutates` value. This count does not decide Then position or a
  read-only environment's policy. Nukadoko trusts `mutates: false`
  regardless of the `observed` value.
- Gherkin classifies an `And` or `But` step with the pickle step type of
  the preceding primary keyword (Given, When, or Then). Gherkin's pickle
  compiler defines this behavior. Therefore, an action after `Then` gets
  the same Then-position observation as other steps in that position. The
  position does not gate the action.
- Measurement cannot decide this fact. Write detection uses the HTTP
  method and counts each non-GET/HEAD request as a write. The method is a
  proxy for write semantics. GraphQL, RPC-over-POST, and many vendor query
  APIs use POST for a semantically pure read. The external system defines
  whether a call changes server state. Nukadoko observes only the lower
  HTTP layer. Each protocol uses different data to distinguish reads from
  writes. Examples include a GraphQL body's `query` or `mutation`, an RPC
  method name, and a vendor path convention. A general mechanical rule
  cannot make this distinction. The count guarantees what a step sent. It
  does not guarantee that the server state changed.
- The record retains all measurements. `observed`, http.jsonl, and the
  Allure declared/observed table remain unchanged. A reader can therefore
  use them to disprove an incorrect declaration after execution. This
  boundary marks the end of the tool's authority over mutation semantics.
- Nukadoko does not perform that comparison. An operator can compare
  `mutates` and `observed` in the same step record without another artifact.
  However, `nuka run` and `nuka check` do not claim that the values conflict.
  Such a claim would treat the HTTP-method proxy as a settled fact. It would
  report every GraphQL read, RPC-over-POST read, or vendor POST read as a
  false positive. For the same reason, nukadoko does not enforce mutation
  semantics at run time. The `nuka accept` record is the only place that
  writes this comparison (see Sign-off). At sign-off, a person already
  reads and judges the run. The record can show the raw facts there without
  adding false-positive noise to every `nuka run` or `nuka check` invocation.
- Compat (untyped) steps have no `mutates` declaration (see "What compat
  steps lack"). The `then-compat-step` warning from `nuka check` identifies
  this coverage gap when a compat step is bound in Then position. It does
  not identify a mutation conflict. Run-time observation records the same
  counts as it does for any step, but those counts gate nothing.

## Compat steps (the migration door)

An existing Cucumber and Playwright suite can adopt nukadoko by changing
one import:

```ts
// before: import { Given, When, Then } from "@cucumber/cucumber";
import { Given, When, Then } from "nukadoko/compat";
```

- Compat steps keep their existing pattern syntax and World (`this`). The
  nukadoko harness provides and manages `page` and `request`. Custom World
  classes use `setWorldConstructor` to extend the nukadoko base. The API
  supports the commonly used subset: Given, When, Then, World, Before,
  After, and AfterStep. New demand determines when this subset grows.
- `Given`, `When`, and `Then` are three names for one registration
  operation. A keyword has no meaning during registration. As in Cucumber,
  the scenario position determines its meaning at run time. A pattern can
  be a plain cucumber-expression string or a RegExp. Compat strings do not
  require named captures because that rule belongs to typed steps. RegExp
  support admits legacy glue that uses regular expressions. Compat accepts
  both cucumber-js call forms: `Given(pattern, fn)` and
  `Given(pattern, { timeout }, fn)`. It applies the specified timeout and
  throws on an unknown option key. Discovery imports each file and assigns
  its registrations to that file. The pattern text identifies a compat
  step. `nuka steps` lists its kind, and `nuka describe` shows that it has
  no contract. `nuka do` refuses the compat step by name. Promotion to
  `defineStep` enables single-step execution.
- `defineParameterType` in compat code and `config.parameterTypes` use one
  registry. Moving a registration to the config does not change pattern
  matching, so a team can make this move early. `nuka check` warns about
  registrations that still come from support code. The config is their
  final location.
- Execution supports two forms. Glue that starts its own Playwright
  continues to work without measurement. `await this.openPage()` and
  `await this.openRequest()` return the measured page and request from the
  harness. Typed steps in a mixed scenario share the same context and
  cookies. Tables use a small, dependency-free `DataTable` with
  raw/rows/hashes/rowsHash/transpose. This preserves glue that calls
  `table.hashes()` after the import change. Docstrings remain plain strings.
  Before and After hooks support all three cucumber-js forms:
  `Before(fn)`, `Before({ tags }, fn)`, and `Before("@tag", fn)`. They
  receive Cucumber's hook parameter. A hook can filter only on `@tag` or
  `not @tag`. More complex expressions fail explicitly to prevent a silent
  mismatch. Hooks appear in the scenario record's `hooks` array and do not
  create step records. Their network traffic remains outside all step
  boundaries. The http.jsonl file and observed read/write totals remain
  scenario-wide and do not identify one hook invocation. Playwright traces
  use a narrower boundary. Each Before, After, or AfterStep invocation that
  uses `this.openPage()` gets a separate trace chunk and `actions` list in
  its `hooks` entry. The entry has `trace`, `actions`, and `truncated`, which
  use the shape of a step record (see "Records"). Each chunk is separate
  from step chunks and sibling hook chunks. A hook has no fixture bag for
  `section` or `poll`, so its entry has no `sections` or `polls`. Only the
  `actions` read from the trace chunk are available. `AfterStep` supports
  the same three registration forms and tag filters. Before and After
  bracket a scenario, while AfterStep runs after each pickle step that
  executed. It does not run for a step skipped after an earlier failure
  because that step never began. This is also the rule for a hook whose tag
  does not match. Each `AfterStep` entry has `step_index`, the zero-based
  index of the executed step in that record's `steps` array. Allure and
  cucumber-messages preserve this index. The hook parameter's
  `result.status` uses the `TestStepResultStatus` strings from
  `@cucumber/messages`. `nukadoko/compat` re-exports the same enum as
  `Status`, so `result.status === Status.FAILED` imports and compares
  correctly. The other members, `PENDING`, `SKIPPED`, `UNDEFINED`, and
  `AMBIGUOUS`, cannot match. Nukadoko has no corresponding concept for a
  hook result. Migrated glue never takes a branch that compares these
  values, and this behavior is not a compat gap. `BeforeAll` and `AfterAll`
  bracket the full run. They accept no tags, have no World, and do not run
  when no scenario is selected. They report through the exit code because
  they do not belong to a scenario record. `setDefaultTimeout` sets the
  default for items without a specific timeout. If the glue does not call
  it, steps have no time limit. This avoids applying Cucumber's five-second
  limit to a slow suite only because the suite migrated.
- Nukadoko always measures the World. Each compat step record lists the
  World keys that the step read and wrote, in access order. This exposes
  data flow through `this.foo`. Measurement covers the bag's own data
  properties. By construction, it does not include `#private` state.
  `defineWorld({ key: zodSchema })` enables validation for individual keys.
  A write that fails its schema fails the step and does not appear as a
  write. `class MyWorld extends defineWorld({...})` adds a type to `this`.
  Cucumber reserves `attach`, `log`, `link`, and `parameters`. These keys
  cannot be measured or declared, and an overwrite causes an error.
- The harness owns the browser and request objects. Therefore, compat steps
  get measured step records without code changes. These records contain the
  status, timing, trace, screenshots, and HTTP log.
- Compat steps lack typed contracts, a validated `result` in the step
  record, and single-step CLI execution. A team can add these properties
  one step at a time by promoting a frequently used step to `defineStep`.
- An audit measured the width of this door. It inspected the glue text of
  eight public cucumber-js suites without running them. At that time, none
  worked after only the import change. Fixes for the observed blockers have
  since brought two suites to a state where compat rejects none of their
  glue. [docs/migration.md](migration.md) lists the remaining requirements.
  The audit established a rule: unsupported compat behavior must fail
  during import or the first run. A migrating team can respond to an
  explicit failure, but it cannot see a silent behavior change. A silent
  change costs more trust than a missing feature costs time.
- Explicit failures divide into static findings and failures that require
  step execution. `nuka check` reports only static findings.
  **`nuka check` can report these failures**: a step file that throws during
  import becomes a `step-file-import-failed` error. Causes include a value
  import that `nukadoko/compat` does not export, a CommonJS `require` in ESM
  glue, and a deep subpath import. A hook tag expression more complex than
  one `@tag` or `not @tag` becomes an
  `unsupported-hook-tag-expression` error. The file text establishes both
  failures before execution. Two additional findings describe the area
  that discovery scans:
  `step-file-unsupported-extension` reports a `.cjs` file under
  `featuresDir` (see "Typed steps" for the import rule).
  `no-step-files-found` reports a scan that found no candidate files. Each
  finding identifies what discovery inspected. The `scanned:` line from
  `nuka tend` uses the same rule so that a reader can verify the finding.
  An `undefined-step` finding can also identify a missing pair of quotes.
  The finding applies when one registered pattern fits the same position and
  all its captures are `{...:string}` parameters. It names the step and
  pattern and gives the rewritten Gherkin line. It stays silent when two or
  more patterns can explain the line, because that choice belongs to the
  author.
  **Only `nuka run` can report these failures**: a step or hook returns
  `"pending"` or `"skipped"`, or glue uses a done callback. These failures
  depend on what the step does during execution. Import analysis cannot
  identify them. **The following case is not a gap**: esbuild removes a
  name that appears only in a type annotation or an unused import before
  nukadoko imports the file. The import does not occur at run time, and the
  glue runs as compiled. `tsc` still resolves the name against compat
  exports. A missing name is therefore a compile error. The audit found
  `IWorldOptions` and `ITestCaseHookParameter` in this category. Exporting
  them prevents a user typecheck failure even though `nuka` cannot observe
  that failure during a run.
- A permanent design rule applies to all migration work. A working compat
  asset must continue to work after a team adopts nukadoko or moves another
  asset to typed steps. A transition can place related definitions in two
  locations. Examples include parameter types in support code and the
  config, or a World bag beside typed results. Both locations must share one
  mechanism. `nuka check` must expose the split. Each migration step must
  preserve semantics so a team can make it early and safely. A team must
  also be able to restore the original import.
- [docs/migration.md](migration.md) gives a step-by-step procedure for an
  existing cucumber-js and Playwright suite. [docs/upgrading.md](upgrading.md)
  explains how to move an existing nukadoko project to a newer release.

## The second door: a Playwright Test suite

The first door serves a suite built on cucumber-js by changing an import.
A suite written directly for Playwright Test has no such import. Its tests
use `test("...", async ({ page }) => {...})`, with no glue layer to
redirect. This suite requires a different migration method.

[docs/migration-playwright-test.md](migration-playwright-test.md) gives the
step-by-step procedure for this door. `docs/migration.md` covers the first
door. The documents serve different readers because a Playwright Test suite
has no compat steps, World, or Cucumber hooks.

**Share the implementation.** Move an operation from a spec file to a plain
async function. The function accepts only Playwright objects. Both the spec
and a typed step's `run` call this function. Each runner loads only its own
files.

```
e2e/cart.spec.ts  ──▶  features/steps/lib/cart.ts  ◀──  features/steps/add-item.ts
   (Playwright)              (plain functions)               (nukadoko)
```

The arrows intentionally point one way. The Playwright suite does not
import nukadoko. After the move, it still depends only on Playwright and a
function in its repository. To reverse the compat migration, restore an
import. To reverse this migration, delete the feature files and steps. The
Playwright suite remains unchanged because its dependencies never include
nukadoko.

The shared API shape makes this arrangement work. `page`, `context`,
`request`, and `baseURL` are Playwright objects on both sides (see "Context
API"). Both callers can use a function that accepts these objects. No
adapter, wrapper, or re-export is necessary.

Do not share anything above this API boundary. A spec must not call
`step.run(bag, args)` directly. Such a call works only while the step uses
Playwright fixture names. It fails when the step uses `call`, `section`,
`resultOf`, or `requireEnv`. These fixtures provide much of the value of a
typed step. A spec also cannot share the fixture map because of the typing
constraint described in "Fixtures."

Place the contract in the shared unit. A step's `args` and `returns` are
plain zod schemas. The function file can export them, and the step can
declare them:

```ts
// features/steps/lib/cart.ts
export const openCartReturns = z.object({ id: z.string() });
export async function openCart(request: APIRequestContext) { ... }

// features/steps/open-cart.ts
export default defineStep({ returns: openCartReturns, run: ({ request }) => openCart(request) });
```

The spec and step import one definition, which keeps their shapes aligned.
The shared file depends only on Playwright and zod, so the dependency
direction stays unchanged.

The **record** is the other half of the migration. Shared implementation
does not create a record. A Playwright run produces Playwright artifacts,
but it has no nukadoko executor to write a step record. A suite can
therefore share all implementation code and still produce nothing for
`nuka harvest`.

`recordStep` creates the missing record. Nukadoko has tested this API with
its own tests, but a real migrated suite has not yet used it.

```ts
const opened = await recordStep(
  openCartStep, { sku }, { name: "open-cart", rootDir, request },
);
const added = await recordStep(
  addItemStep, {}, { name: "add-item", rootDir, request, use: [opened.stepRecordId] },
);
```

**Pass the record id.** A spec usually stores a returned value in a
variable and passes that value to the next call. This action does not record
a chain. The `use` option declares the chain with the same meaning as
`nuka do --use`. Without `use`, the record treats the key as a value from
the caller. `nuka harvest` then writes that run's id into the draft. The
draft passes against a server that remembers the id but fails against a
new server. Passing the record id lets `from` provide the value, as it does
during `nuka run`.

The step uses the spec's `request`, enforces its schemas, and writes a step
record beside records from `nuka do`. The existing suite becomes a source
of records. `nuka harvest` can turn its existing journeys into drafts. This
method asks the team to run existing code instead of rewriting it.

`recordStep` accepts a `page` as well as a `request` and gets the context
from `page.context()`. It therefore supports browser-based and HTTP-based
suites. Evidence collection adds listeners to the caller's context. It
removes them when execution ends. Otherwise, one recorded step would
continue to count traffic from the rest of the spec.

An external record contains less data than a `nuka run` record. It has no
trace chunk, screenshot, or `http.jsonl` line for page traffic. Playwright
already produces these artifacts, so a second copy adds no information.
The external record keeps the data that only nukadoko measures: args, the
validated result, `observed`, and page events.

Three properties preserve the meaning of the record. First, the record has
`kind: "external"`. This is the third execution source beside `do` and
`run`, and it distinguishes the record from a command that a person typed.
`harvest` accepts an external record and continues to refuse a `run` record
that already has a feature. Second, nukadoko wraps the injected request
context for standard logging and redaction. It never disposes that context
because another owner opened it. Disposing it would cause a failure on a
later call. Third, nukadoko refuses a browser-dependent step before it
creates a record unless the call supplies a `page`. This path never starts
a browser.

The **sign-off** still requires a different path. `nuka accept` requires a
successful full `nuka run` and its scenario record. An external record does
not meet this requirement. Nukadoko can guarantee only an execution that
it drove. An external record is a working record like a `do` record. It is
source material for a harvested scenario, and it is not acceptance
evidence.

This migration opens both nukadoko paths. `nuka run` fixes a path in a
feature file, and `nuka do` runs each step alone. Operations that the
existing suite already trusts become the vocabulary that an agent uses for
exploration (see "Single steps" and "Live sessions").

Both trees can exist in one repository. A team can put them side by side.
Alternatively, it can put `featuresDir` *inside* the directory that already
contains the specs. The second arrangement requires less movement when the
Playwright suite is the primary asset.

```
e2e/
  cart.spec.ts          <- Playwright finds this
  lib/cart.ts           <- shared, owned by neither runner
  nukadoko/             <- featuresDir
    cart.feature
    steps/add-item.ts   <- Playwright does not find this
```

Each runner loads only recognized files. Playwright collects files that
match its `testMatch`. A step file named after its step does not match.
Discovery imports each `.ts`, `.mts`, `.js`, or `.mjs` file under
`featuresDir`. A spec outside that directory is outside the discovery
area. These naming and placement rules do not conflict.

Nukadoko reports two incorrect arrangements explicitly.

Discovery imports a spec **inside** `featuresDir`. Playwright's `test()`
then refuses to run outside the Playwright runner, so the import fails.
`nuka check` identifies the file and includes the Playwright message.
`run` and `do` refuse execution as they do for other broken glue.

A step file **named like a spec** causes a different conflict. The file
basename defines the step name. Therefore, `open-cart.spec.ts` defines a
second step named `open-cart.spec` with the first step's pattern.
`nuka check` reports `ambiguous-step` and identifies both steps. The error
is one pattern that matches multiple steps. Rename the file to fix it.

In both arrangements, place the shared file outside `featuresDir`.
Discovery could import it without harm because the module defines no step.
However, its location shows that the existing suite owns it.

## Running

### Scenarios (the scripted path)

```sh
nuka run <feature[:line]|dir>... [--env <name>] [--session <name>] [--concurrency <n>] [--quiet]
```

`@cucumber/gherkin` compiles the file into flat, self-contained pickles.
The compiler merges Background, expands Scenario Outline, and attaches tables.
nukadoko matches each pickle step against the committed patterns, then executes
the steps in order. It writes one step record for each step and one scenario
record for each pickle. The scenario record contains the feature path, scenario
name, ordered step record ids, and per-step status.

`nuka run` takes one or more targets. Each target can be a feature file, a
`file:line` selection, or a directory. A directory target is walked
recursively for every `.feature` file. The selected files form one
deduplicated set, and a full-file selection includes any line selections for
that file. All selected pickles belong to one invocation: one run_id, one
summary, one exit code, one messages stream, and one Allure results tree.
Files are visited in a fixed order, the repo-relative path
compared byte by byte rather than by locale, so which scenario ran in which
position stays stable across runs and a record or a report can be compared
against another one. `--concurrency` below keeps that visiting order and
gives up the position: the files are still handed out in it, and the
records land in the order the workers finish. `:line` on a directory is
refused: it selects one scenario inside a single file, and a directory
names no single file for it to select inside. A directory holding no
`.feature` file anywhere under it is refused too, the same tone
`nuka check`'s own `no-step-files-found`
uses: it names exactly what it scanned, because a run that did nothing must
say so loudly rather than exit 0 having run nothing at all.

`--concurrency <n>` runs more than one feature file at a time. The default
is 1, and at 1 every other paragraph in this section describes what
happens.

nukadoko spreads the work across worker processes. The parent selects the
pickles, hands each worker whole feature files, and each worker executes
the files it was given with the same serial engine a `--concurrency 1` run
uses. The parent keeps the
run's identity throughout: one run_id, one stdout stream, one messages
stream, one Allure results tree, one summary, one exit code. A scenario
record therefore reads the same whether a worker produced it or a serial
run did, and `nuka accept` still sees one run covering every line of a
feature.

The spec names worker processes because that choice decides what the flag
can promise, so swapping in threads or promises later would change the
promise too. A scenario spends its time in a browser, in an HTTP call, or
in the project's own JavaScript, and only the last of those blocks a
single event loop. Concurrency inside one process
would reach the first two and leave the third exactly as slow as it was,
and nukadoko cannot measure which of the three a suite it was handed is
made of. A flag that speeds up some suites and silently does nothing for
others is a promise the tool cannot keep. Separate processes reach all
three.

The unit of distribution is the feature file. Every scenario in one file
runs in one worker, in file order, so a Background and the scenarios after
it keep the relation they have at concurrency 1. Files are handed out in
the same fixed byte order they are walked in, so which worker gets which
file does not drift between runs. `--concurrency` above 1 therefore has
nothing to do for a target naming a single file, and `nuka run` says so
rather than starting workers that would sit idle.

A `@serial` tag on a `Feature:` line runs that file while no other file
runs. This is the declaration for a suite whose files share something
nukadoko cannot see: one test account, one row, one queue. A fixture's
scope can never answer this question, because a scope reaches only what
nukadoko itself builds; the feature file is where the answer belongs,
beside everything else it already names. The tag is read on the `Feature:`
line only. On a `Scenario:` it would do nothing at all, since the scenarios
inside one file already run in one worker, so `nuka check` reports it
(`serial-tag-on-scenario`) instead of letting it read as a rule that is in
force.

A `"process"`-scope fixture is built once per worker, and a compat
`BeforeAll`/`AfterAll` runs once per worker, because a worker is a process.
The "Fixtures" section already defines `process` scope as once per address
space, and this flag is where that definition becomes visible. Something
that must happen exactly once in the world, a database seed or a mock
server that owns a port, belongs in neither of those places at any
concurrency.

Two things change above 1, both deliberately. stdout lands in completion
order rather than file order, since the parent writes each record the
moment a worker reports it. The per-step progress lines on stderr are held
until their own scenario finishes and are then written together, because
lines from several scenarios interleaved are lines nobody can read.
Neither changes what a record contains.

`--session` does not combine with a concurrency above 1. A session hands
login state from one scenario to the next, so each scenario starts from
what the one before it left. `nuka run` drops to one worker and says so on
stderr, in the same category as the paths it writes, which `--quiet` never
suppresses.

`--concurrency` is a flag and never a config key. How many scenarios a
machine can run at once is a fact about that machine, and a committed
config file is the wrong place to keep it.

Each run uses two output channels for two readers. stdout contains only NDJSON,
with one scenario record per line for scripts to parse. stderr contains the
output for a person who watches the run: a boundary before each pickle, one
line after each step, the paths written by the run, and a one-line summary.
`--quiet` suppresses the per-step and per-scenario progress lines. The paths
and summary still appear because the flag makes the terminal quieter, not
silent. After the summary line, stderr names each failed scenario with its
feature path, line, and name. These lines appear for serial and concurrent
runs, and `--quiet` keeps them.

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
permissions for the same reason (see "The state directory"). It is not
kept beside that file, though. Every platform caps how long a unix socket
path may be, a project's own path can be arbitrarily deep (a worktree, a
package inside a monorepo, a nested checkout), and a cap that a project's
location can push past is one no amount of shortening a session's name
gets back under. The socket lives in a private directory of its own under
the operating system's temp directory instead, so its length does not
depend on where the project sits, and the session's lock file names the
path once it exists. An idle
timeout applies by default, because a forgotten session is the normal
outcome of an interrupted exploration rather than an unusual one, and
`nuka session list` reaps the ones whose pid is gone.

The honest limit is the point of the feature rather than a flaw in it: a
world thirty executions deep is not reproducible, by anyone, including
the process holding it. That is why what comes out of an exploration is a
draft to be harvested and run again from nothing, not the run itself.

## Records

A step record contains the tool's measurements for one step execution. Its
shape is the same whether the step ran in a scenario or through `do`. A
scenario record (see "Running") answers the same question at the next level.
It shows what one pickle run did across its ordered steps. Both records show
the same concept at different resolutions. The scenario record's `steps`
array identifies each step record by id, so either record leads to the other.

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

- `result` provides the trust anchor: it passed the returns schema and the tool
  (not the caller) produced it. On failure, `error: { kind, message }`
  replaces it. Compat steps record `result: null`.
- `args` uses the same distinction (see "Typed steps" for the refusal this
  backs). On an `ok` record it is the schema-validated value `run`
  actually received, a schema's own `.default(...)` included even where
  the caller never typed the key; on a `failed` one it is exactly what was
  given, since a value the schema already rejected cannot be reconstructed
  into the validated shape. A compat step's `args` is never validated
  either way, having no schema to validate against.
- `scenario_record_id` and `run_id` identify what this execution belongs to:
  the owning scenario record's id and the `nuka run` invocation's own id
  for a `run`-originated step (`kind: "run"`), both `null` for a
  `do`-originated one, which belongs to neither. Without `run_id`, telling
  which run one step record came from meant opening the scenario record
  beside it first; a step record answers that on its own now, the same way
  it already answers everything else about what this one execution did.
- `error.kind` uses a closed set and sits beside the message a person reads:
  `args_invalid`, `result_invalid`, `binding_invalid`, `world_invalid`,
  `timeout`, `unsupported`, `step_error`. Closed because a report has to
  classify against it: an open one, extended per step, would classify
  nothing. The first four name failures that exist only because there is a
  contract to violate, which is the part a report built on a runner that
  discards return values cannot fill in; a classifier that isn't sure says
  `step_error`, since claiming a contract failure wrongly is worse than not
  claiming one. Hook records in the scenario record carry the same field.
- `mutates` contains the step's declaration (`null` for a compat step, which
  has none to record, not `false`), sitting beside the `observed` counts
  so declared and measured can be compared without a second artifact.
- The harness collects evidence; the step never reports it: Playwright
  tracing and screenshots when the browser is used, every `request` fixture
  call and the page's own document/XHR/fetch traffic alike logged to
  http.jsonl, the step record itself as the primary one.
- `evidence.screenshots` contains at most one entry, `{ "file": "final.png", "at":
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
- `observed` counts the network calls that the tool saw during the execution,
  through the `request` fixture and the page; non-GET/HEAD counts as
  a write (HTTP method as a proxy for write semantics, not semantics
  itself), so a POST-based read counts against a step that never wrote
  anything (see Keyword semantics). It settles nothing on its own: Then
  position and read-only environments act on the `mutates` declaration,
  never on this count. `observed` sits beside `mutates` (declared) so a
  wrong declaration is falsifiable, here and in the Allure report.
- `evidence.http` (included only after at least one call was logged) points to
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
- `evidence.attachments` (included only when it has entries) lists what
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
- `http_omitted` appears only when at least one page request was omitted.
  It makes the omission visible by counting what
  didn't make it into http.jsonl, by resource type, e.g.
  `{ "image": 34, "stylesheet": 5, "script": 12 }`. `observed` (above) is not
  narrowed by any of this: it tallies every request the harness saw, image
  and script traffic included, because it answers a different question (how
  many reads and writes actually happened) than http.jsonl does (which of
  those calls are worth reading one by one). The two counts are not
  expected to add up to each other, and neither being lower than the other
  is a bug.
- `used` (included only when it has entries) lists the earlier executions whose
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
- Only a **failed** step record adds `result` to each `used` entry. It contains
  the upstream step record's full validated result,
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
- `calls` (included only when it has entries) lists the parts this execution ran
  through the `call` fixture (see "Parts"), in call order. Each entry is
  `{ "step": "create-project", "args": {...}, "result": {...},
  "started_at": "...", "finished_at": "..." }`, and carries `error`
  instead of `result` when the part failed, classified the same way a step
  record's own `error` is. Unlike a step record's own top-level `args`
  (above), `args` here is always the raw value `call()` was given, on both
  outcomes: what changed for a part is what `call()` accepts, never what
  gets written down. A part that called a part carries its own
  `calls` under that entry. These are not step records and have no
  `step_record_id`: `--use` cites a step record, and what this execution
  offers a later one is its own `result`. Recording the args and the
  result at each internal boundary is what a composite step's record is
  read for once it fails, since the values that crossed those boundaries
  are otherwise nowhere.
- `sections` (included only when it has entries) lists the `section` calls
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
- `polls` (included only when it has entries) records every `poll` call that
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
- `required_env` (included only when it has entries) lists the names
  `requireEnv` was called with during this execution, deduplicated, in
  the order first read: the same measured-not-declared shape `used` and
  `sections` already have, since `requireEnv` is the one call site the
  library controls. Recorded before a missing key throws, so a
  `MissingEnvError` failure's record still shows what the step asked for.
  Only names are recorded, never values: a value can be a secret. A step
  that reads `env[name]` directly leaves no trace here: this field
  counts only what passed through `requireEnv`, never a plain object read
  the library never sees.
- `page_events` (included only when at least one category has entries)
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
- `actions` (included only when it has entries) comes from this step's
  trace chunk (`evidence.trace`, above): every Playwright call the step made
  through the `page` fixture, `expect` waits included, in the order the
  trace recorded them finishing. One exception: Playwright itself runs an
  internal watch for `console`/`weberror`/`requestfailed` events on every
  browser context, and that watch is not a call the step's own code made, so
  it is excluded from `actions` rather than reported as one. `expect` is deliberately not a fixture
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
- Before, After, and AfterStep hooks have no step records (see "Compat
  steps"). Their trace evidence therefore appears in the invocation entry in
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
- `fixtures` (included only when it has entries) lists every `config.fixtures`
  entry this step's own bag resolution actually touched, `{ "name",
  "scope", "setup_ms"?, "at"?, "reused" }` (see "Fixtures" for the full
  shape and why `setup_ms`/`at` are only present on a freshly built entry).
  Teardown itself is not on this list: it runs after this step record is
  already closed, so a `scenario`-scope fixture's own teardown failure
  lands on the scenario record's `teardown_errors` instead (see
  "Fixtures").
- Step records are stored under `.nukadoko/records/steps/<id>/`. Scenario
  records are stored under `.nukadoko/records/scenarios/<id>/` (see
  "Artifacts"). Both are
  local working measurements; the durable artifacts built from them are
  sign-offs.

## Sessions, environments, secrets

Nukadoko provides execution infrastructure that Cucumber did not provide:

- **Sessions** carry login state across CLI calls as Playwright storageState.
  Nukadoko stores each session by environment and uses an advisory lock to
  limit it to one run at a time. Without `--session`, each run starts clean
  and has no implicit shared state. Sessions do not use a daemon.
- **Environments** name deployment targets. Each environment can define a
  `baseURL`, `envFiles`, `policy: "read-only"`, and an optional `version` probe.
  The read-only policy refuses mutating steps. Each step record stores the
  probe result as `target_version`. A sign-off freezes the environment and
  version, so the record identifies the deployment where the run was green.
- **Secrets** use git to classify their *origin*. An ignored or untracked env
  file is a secret source. Nukadoko does not distinguish between those two git
  states. Every value in a secret source is a secret without a declaration.
  A tracked env file is plain configuration because its values are committed.
  Outside a git repository, nukadoko treats every envFile as a secret source.
  Origin and *handling* are separate questions. `secrets.public` makes one key
  from a secret source plain and prevents its redaction. `secrets.redact` tells
  nukadoko to redact one key from a tracked file. This instruction preserves
  git's origin classification. It prevents the value from spreading to a new
  surface, such as a terminal, CI log, pasted bug report, or agent transcript.
  Both origins use the token `{{secret.NAME}}`. There is no separate
  `{{redacted.NAME}}` marker, so readers need to recognize only one redaction
  form. A key cannot occur in both `public` and `redact` because the two lists
  give opposite instructions. Nukadoko reports this conflict as a config error.
  The executor redacts secret values from either origin when it writes a step
  record surface: `record.json`, the stdout copy from `do`, or http.jsonl.
  A step's `run` cannot control this process. Values shorter than four
  characters are never redacted, including values named in `redact`. Nukadoko
  can redact only values that it loaded. It cannot detect a new token in a
  step result. A tracked value remains plain on all record surfaces unless
  `secrets.redact` names it. Those surfaces include an agent transcript, which
  did not exist when `.gitignore` classified tracked and untracked files.
  Therefore, repository membership does not classify that new surface. Traces
  and screenshots are not redacted, so the state directory is sensitive.
  `nuka check` reports each env file classification and its secret key names,
  but never their values. It also reports three warnings. The first warns when
  `secrets.public` or `secrets.redact` names a key that no configured envFile
  defines. The second warns when `secrets.redact` names a value that is too
  short for redaction. For tracked env files, the third warns when a key name
  suggests a secret but `secrets.redact` does not name it. The patterns are
  `SECRET`, `PASSWORD`, `TOKEN`, `CREDENTIAL`, and a `KEY` suffix. This name
  heuristic controls only the warning. Redaction depends only on git's
  tracked or untracked classification and `secrets.redact`.

Configuration lives in `nukadoko.config.ts` and uses `defineConfig`. The table
lists each accepted key. A key with more details points to a later paragraph
or to the section for its feature.

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

`additionalFeatureDirs` defaults to `[]` and has a different purpose from
`featuresDir`. `featuresDir` defines the set that runs unattended. With no
argument, `nuka run` processes exactly that directory. The additional list
does not widen the run set. Static checks bind vocabulary against both
`featuresDir` and `additionalFeatureDirs`. Thus, `nuka check` with no argument
and `nuka tend` walk the wider set. Pattern binding is a project property,
independent of the current unattended run. An acceptance feature outside
`featuresDir` belongs in `additionalFeatureDirs` (see "Sign-off"). Its steps
then count as bound instead of producing `pattern-unbound`, but the feature
does not run unattended. An accepted feature that describes a core product
path moves into `featuresDir` and needs no additional entry. A missing entry
is a config error. `nuka check` reports `additional-feature-dir-missing`, and
`nuka tend` reports the same condition as a note.

`browserType` selects the Playwright engine that `ctx.page()` launches. The
choices are `"chromium"` (default), `"firefox"`, and `"webkit"`. It is separate
from `browser` because Playwright's `LaunchOptions` type has no engine key.
Playwright selects an engine through the called `launch` function. An option
does not select it. Putting the selector in `browser` would add a field that
`LaunchOptions` does not accept. This would break the contract that passes the
Playwright type through unchanged. Firefox and webkit each require their own
binary (`npx playwright install firefox` or `webkit`). Only a launch can show
whether the binary exists, so `nuka check` makes no claim. At launch time,
Playwright reports a missing binary without interception or revised wording.
The scenario record `browser` field stores the measured engine and version
that the run launched (see "Running").

`browser` directly accepts Playwright's `LaunchOptions` type. zod checks only
that the value is an object. The type comes from `defineConfig`, so `tsc`
reports a typo as it does elsewhere in `nukadoko.config.ts`. Repeating the
Playwright options in zod would require an update for every new option. Until
that update, config authors could not use the new option. Nukadoko currently
reads only `headless` and passes it to the selected engine's `launch` method.
`browserType` selects that engine. When omitted, Playwright uses its default,
`headless: true`. Options such as `viewport` belong to a different Playwright
type for `newContext`. This key does not accept them. See `browserContext` and
`requestContext` below.

`browserContext` and `requestContext` configure the two `newContext` calls.
Nukadoko builds `browser.newContext()` when a step bag names `page`. It builds
`playwrightRequest.newContext()` when a step bag names `request`. These calls
use different Playwright option types, so each has a separate config key. Both
keys follow the `browser` policy and use Playwright's type directly. This makes
options such as `ignoreHTTPSErrors` available for local targets with a
self-signed certificate. Previously, neither fixture could set that option.
Both keys reject `baseURL` and `storageState` with an error that gives the
reason. `config.baseURL` is the single source for the project base URL, and
nukadoko's session mechanism sets `storageState`. Accepting these values again
would let the config contain conflicting sources.

A `parameterTypes` entry registers a custom cucumber-expressions parameter
type with the shape `{ name, regexp, transformer? }`. For example,
`{ name: "negation", regexp: /( not)?/, transformer: (s) => s === " not" }`
lets a pattern bind `will{negated:negation} return` to a plain `z.boolean()`
args key. Registration belongs in config because config is executable
TypeScript. The version probe is a function for the same reason. Nukadoko has
no support-file format for this registration. Names must not conflict with
built-in types. A project-specific definition of `{int}` would silently change
each pattern that uses it. The transformer performs coercion, while the args
schema remains the contract.

An environment entry is `{ baseURL?, envFiles?, policy?: "read-only",
version?: () => string | Promise<string> }`. Its `baseURL` overrides the
top-level value. Its `envFiles` follow the top-level list, and later files win.
This order provides the common and override layers familiar to dotenv users.
Only an environment can define `policy` and `version`. Without `--env`, the
environment name is `default`, which needs no entry. An explicitly named
environment must exist because its name asserts that it exists. The `version`
probe is a function because config is executable TypeScript. A URL and
jsonPath DSL would only provide a more complex form of `fetch`. The tool calls
the probe once per run with a 10-second budget. An exception or timeout removes
only `target_version`; it does not stop the run.

This example defines both `environments` and `fixtures`:

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

Nukadoko writes all run-time data under `.nukadoko/`. `init` adds this directory
to gitignore, and the data is not for commits. The data uses three directories
for separate purposes (see "Artifacts"):

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
- `export/messages.ndjson`: the messages emitter's output. This path only
  ever holds the most recently *completed* run's own stream, replaced
  atomically once that run finishes; each invocation's real, in-progress
  write target is a run-id-suffixed sibling beside it instead
  (`messages.<run_id>.ndjson`, truncated at that invocation's own start),
  one per `nuka run` invocation, left on disk afterward (see "Messages
  emitter"). `nuka clean [--export]` is what removes the accumulated ones

`nuka clean [--records] [--cache] [--export] [--dry-run] [--json]` deletes data
across all three directories. With no category flag, it deletes every category.
One category flag limits deletion to that category. The command refuses all
categories while any `nuka session` is live. That session process can still
write to `records/` and `export/` (see "Artifacts" for the full reason). The
command never touches `export/allure-history.jsonl`. This file is beside
`export/allure-results/`, outside that directory. It is the only artifact under
`.nukadoko/` that a new run cannot reproduce.

The repository contains the durable artifacts: feature files, typed steps, and
sign-off records.

## Sign-off

A sign-off records that an agreed scenario was green at a named commit. The
claim applies to that commit and does not provide an ongoing check. The scenario
comes from the ticket's acceptance criteria. After a green run, the project
keeps it as an acceptance record. Nukadoko does not rerun it automatically.

Signing off and running a feature answer different questions. A sign-off records
that the criteria were met at one commit. A later run, in CI or elsewhere,
checks whether they still hold. After sign-off, the project selects the future
role of the scenario. Most acceptance criteria describe a requested change.
After that change lands, another run has no remaining claim to confirm. The
feature stays in place and appears in `additionalFeatureDirs` (see "Sessions,
environments, secrets"). Static checks continue to bind its steps, but it does
not run unattended. Some scenarios describe a lasting path through the product.
Those features move into `featuresDir`, where `nuka run` selects them on each
future commit. See "Tending" for the treatment of their sign-offs.

```sh
nuka run acceptance/PROJ-123.feature     # execute, as often as needed
nuka accept acceptance/PROJ-123.feature  # freeze the last green run
```

- `accept` does not execute the feature. Sign-off is an explicit act and is
  never a side effect of a green run. Thus, repeated acceptance until success
  is not a meaningful loop. The command freezes the newest green run of the
  feature. The feature path identifies runs. Run ids are for machines that read
  `nuka run` output, so people do not type them here.
- The frozen run must cover the complete feature. A run selected with
  `<feature>:<line>` covers one scenario and cannot qualify, even when green.
  Freezing it would place a record beside a feature that the run mostly did not
  reach. The command reports four outcomes separately: no run exists for the
  feature, the latest full run was red, only partial runs exist, or no green
  full run exists for the current condition (described below). A refusal names
  the data used for its decision. This includes the run, its start time, its
  failed scenarios, or the conditions that have a run. The record then supports
  the choice of the next command.
- A sign-off applies to one `(environment, browser)` condition. Both values
  come from measurements of the run. They do not come from declarations.
  `environment` is
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
- The command requires a completely clean working tree, including untracked
  files. It also requires a run from the current HEAD. The
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
- A red run produces no acceptance record. There is no verdict field or failure
  record. The project fixes and reruns a scenario that did not pass. It keeps
  the outcome instead of the attempts.
- Nukadoko writes the record beside its source feature. The name is
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
- On success, `nuka accept` writes the record path to stdout. The rules below
  do not change this output. On stderr, it asks whether the feature describes
  the change or a product path. It also explains the location for each answer.
  This output is guidance because the command cannot measure the feature's
  role. It can only identify the choice.
- Near the top, the record body contains a "Condition" section. It contains the
  `environment` and the measured browser engine and version when a browser ran.
  Otherwise, the section explicitly says that no browser ran. This statement
  distinguishes that condition from an unchecked blank field. Older records
  can lack this section. `nuka tend` treats their condition as unknown, does
  not infer a condition, and excludes them from comparisons (see "Tending").
- The tool builds the acceptance record from the frozen run. It includes the
  complete feature text, the scenario record, and each step record. It limits
  the content to fields named by the step contract. Incidental browser actions
  stay outside the record. A person never transcribes it because transcription
  would turn a measurement back into a claim.
- A step record kept here carries `step_record_id`, `step`, `kind`,
  `status`, `args`, `result`, `error`, `used`, `mutates`, `observed`,
  `calls`, `fixtures`, `required_env`, `world`, `started_at`,
  `finished_at`, `environment`, `session`, `session_execution`,
  `scenario_record_id`, `run_id`, and `target_version`. It drops
  `evidence`, `actions`, `truncated`, `page_events`, `http_omitted`,
  `declared`, `sections`, and `polls`: a live step record under
  `.nukadoko/` still carries every one of them (see "Records"), but none
  is something the step's own contract named. A hook entry in the
  scenario record (see "Records") keeps `type`, `status`, `error`, and
  `step_index`, and drops `declared`, `trace`, `actions`, and `truncated`
  for the same reason.
- An allowlist controls the embedded step record. Only a field named above
  survives. A field the live
  step record gains later is stripped by default until it is named
  above. The record states, once near the top rather than once per step,
  every key it stripped from the step and hook records below it. A
  reader never has to guess what was withheld.
- Browser traces cause the stripped fields to grow fastest. In one measured
  suite, two scenarios with 14 steps produced a 3,844-line record. The
  `actions` field used 2,288 lines, or 60% of the total. A record of that size
  gets gitignored, which removes the sign-off from the repository and review.
- Each scenario includes a summary table that fits on one screen. Its columns
  are `step`, `status`, `ms`, `mutates`, `reads`, and `writes`. `ms` is the gap
  between that step's own `started_at` and `finished_at`. `mutates` is
  the step's own declaration; `reads` and `writes` are its `observed`
  counts, the same pair "Declared vs observed" compares below. With the
  JSON this narrow, the summary table is where a reviewer actually reads
  the record.
- The record ends with a "Declared vs observed" section. It includes each step
  in every scenario that declared `mutates: false` but made at least one
  measured write
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
- The record has no separate ticket link because Gherkin already provides the
  required space. A tag and the free description under `Feature:` carry the ticket
  id, its URL, and the acceptance criteria in the reviewer's own words;
  freezing the feature freezes all of it. nukadoko has no concept of a
  ticket and needs none.
- Nukadoko has no plan subsystem or reasoning field. The feature file and its
  bound typed steps answer what would prove the criteria. Reviewers decide
  whether the scenario expresses those criteria during the feature's PR review.
  A sign-off records that the agreed check ran.

A sign-off makes only a past-tense claim. This scope prevents the decay of a
requirements traceability matrix. A matrix claims to describe the current
system, so a system change makes it drift. The statement "green at commit X"
remains true. The record makes no claim about current software behavior.

The record is unsigned plain-text markdown. Nukadoko does not verify that it
still matches the original output from `nuka accept`. Git detects later edits.
The project commits the record like any other file, so later changes appear as
diffs against the commit that added it.

### The acceptance loop

An agent follows this process for a ticket's acceptance criteria:

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

Steps 1 through 4 contain the work and review. New typed steps and the feature
are ordinary PR material. A reviewer checks the translation from criteria to
scenarios. Steps 5 through 7 are mechanical, and the tool refuses an invalid
operation explicitly.

This loop starts from criteria. "Harvesting" starts from exploration and joins
this loop at step 3.

## Harvesting

`nuka do` provides the adaptive loop (see "Single steps"). The agent reads
one validated result and uses it to choose the next call. The resulting
ad-hoc sequence is a working record, not evidence, because nobody agreed
that it was the story. An exploration can therefore find something real
but leave the finding in a form that cannot gate anything. Its path remains
only in a directory that is safe to delete.

`nuka harvest <step-record-id>...` builds one feature draft from those
records and prints it to stdout. The command connects two things that this
tool keeps separate: a path found through adaptation and a path fixed in
a sentence that someone accepted.

```sh
nuka harvest step-20260817-a1b2 step-20260817-c3d4 > acceptance/cart.feature
```

The command follows the same division of labor as the rest of the tool.
Harvest fills in only what it measured: the steps that ran, their order,
each line's text, and values supplied by an earlier execution instead of
the line. It leaves every **claim** blank because step records do not
contain claims.

The draft has two forms of the same blank. `Feature:` and `Scenario:` use
placeholders instead of generated names. Each line uses `*` instead of
`Given`, `When`, or `Then`. A keyword tells the reader what a line means,
but the records state only what ran. Choosing a keyword would invent an
unsupported claim. `*` is a valid Gherkin keyword with no position, so the
draft parses and `nuka check` can read it before the narrative exists.

The rejected alternative derived the keyword from `mutates`. A wrong guess
is worse here than no guess because a plausible keyword can survive review,
while `*` cannot. The agent or person who finishes the draft would also
have to verify any generated guess.

**The command line selects the records in one sequence; no record stores
that grouping.** `do` deliberately has no grouping label because one would
make an ad-hoc sequence resemble evidence. Each `do` prints its step record,
so the caller that runs the adaptive loop already has every id. A time
window (`--since`, `--last 10`) would guess and could include an abandoned
probe. A reader could not distinguish that probe from a real line.

The command line selects *which* records to use, but it does not set their
order. The draft sorts them by `started_at`, so reversed ids still produce
the sequence that ran. Here, order is a measurement and the argument list
is only a selection.

A value that does not appear on a line remains in the chain. A step
record's `used` identifies the execution that supplied each `from` key
(see "Records"). This information is measured, not reconstructed, so
harvest omits the key and lets the producer's line supply it. The binding-
order check shared by `nuka check` and `nuka run` then proves the order
before execution. For a key from `--args`, harvest writes the value into a
matching capture. It can also write the value into a docstring or table
when that input can consume the one remaining required key (see "Typed
steps"). If the key fits none of these locations, harvest omits it and
adds a comment. `check` then refuses the line for its usual reason.

Harvest records three unresolved cases in both the draft and stderr.

- **A step with no `pattern`** cannot become a line. Harvest adds a comment
  that names the step and its args. The scenario's purpose determines
  whether this is a step without a sentence or a part inside another step.
  The draft states the measured fact and leaves that judgment open.
- **A record whose execution failed** becomes a line with a comment that
  states how it failed. This preserves a useful case: an exploration that
  reproduced a bug becomes a red scenario. The scenario becomes green
  after the behavior changes and can then be accepted. A red draft cannot
  become evidence accidentally because `nuka accept` requires a green full
  run (see "Sign-off"). A failed record cannot supply a chain either,
  because `--use` already refuses it. The reconstruction therefore remains
  sound.
- **A line that does not read back** to its source record remains unresolved.
  A pattern can contain optional text (`item(s)`) or an alternation
  (`is/are`), and neither has one reverse form. Harvest therefore reads
  every generated line through the matcher used by `nuka run`. It verifies
  that the line resolves to the same step and args. For a mismatch, harvest
  reports the line, the generated text, and the parsed result.

This round trip is the only place where harvest judges its output. It uses
the `run` matcher instead of a second implementation, so both commands use
the same meaning for a line.

Provenance goes to stderr, not the feature file. The ids point into the
gitignored state directory, which is safe to delete (see "The state
directory"). A committed feature that named these ids would contain
references that readers cannot follow. Working information stays with the
work, while the durable feature file keeps only facts that remain true.

Harvest refuses a step record from `nuka run`. That record already belongs
to a feature, so generating a second feature would not help. The refusal
names the source scenario record instead.

## Allure emitter

`nuka run` writes one Allure test result for each scenario pickle.
The emitter uses the Allure 2 file format, which Allure 2 and Allure 3 can read.
By default, nukadoko writes results to `.nukadoko/export/allure-results/`.
nukadoko does not render HTML.

`allure.resultsDir` moves the output to another root-relative path.
The emitter has no enable flag and runs when an invocation selects at least one pickle.
It is skipped, the same reason BeforeAll/AfterAll are, when an invocation selects zero pickles: no `allure-results/` directory is created at all in that case.
`categories.json` and `environment.properties` are written once, at the very start of a run, before the first step runs.
`nuka init` creates the default directory so `allure watch` can start before the first run.

Each result uses the pickle name and stores its Gherkin steps in `steps[]`.
A step name preserves the Gherkin keyword and its AST whitespace, including `And`.
The step entry keeps its status, timing, parameters, attachments, declared logs, calls, and measured child timeline.

The result uses these labels and paths:

- The `feature` label contains the Feature name.
- The `package` label contains the project name and feature path, separated by dots.
- Each inherited pickle tag becomes a `tag` label and retains its `@` prefix.
- The scenario result receives all declared labels and links.
- `titlePath` contains the project name, feature directory segments, and Feature name.
- The emitter leaves `parentSuite` and `suite` unset.
  Users who need that hierarchy can add suite labels through declared labels.

`fullName` is `{project}:{feature path}#{scenario name}`.
The SDK derives `testCaseId` from `fullName`.
`historyId` is a deterministic hash of `fullName`, `testCaseId`, and every parameter the scenario result carries that is not marked `excluded`.
The scenario's own name is not a separate hidden parameter: it already reaches `historyId` through `fullName` itself.
The one hidden parameter every scenario result carries for identity is `nukadoko.scenario.steps`, every one of that scenario's own step texts joined in order.
It is `mode: "hidden"` rather than `excluded: true` on purpose: Allure drops an `excluded` parameter before hashing it, which would defeat the whole point, where `hidden` only keeps a parameter out of the UI.
A Scenario Outline row adds each Examples cell as a visible parameter, which also feeds `historyId`.
The visible cells replace the former hidden row parameter and distinguish rows.

Two scenarios can share a Gherkin name, most often as two rows of one Scenario Outline. Without more input to the hash, both would use the same `historyId`, and the second would enter the first scenario's history.
`nukadoko.scenario.steps` closes that gap for a plain scenario, and an Outline row's own Examples cells close it for a row.
What neither can rescue is two scenarios sharing a name *and* every step's own text, with no Examples row to tell them apart: that pair stays indistinguishable, on purpose.
A wrong link is worse than no link, so this identity never guesses past what it can actually tell apart.

This identity preserves a plain scenario's history across the structure change.
A Scenario Outline row starts one new history after the change because its visible parameters change the identity.
The emitter does not write the TestOps migration field `_fallbackTestCaseId`.

A step entry has no identity that survives across runs. The Allure step-result model has no `labels`, `links`, or `historyId` field that could store one.
Four ways of computing one anyway were tried before this design: step text (two steps can share the exact same wording), position (an edit anywhere earlier in the feature file shifts it), and counting occurrences (an inserted duplicate is indistinguishable from the original it landed next to).
A line-number scheme made the failure mode concrete: one comment line added at the top of a feature file silently re-pointed every step at its neighbour's history, with nothing on the report hinting that it had happened.
A wrong link is worse than no link, and every scheme tried produced one, so a step entry gets no identity at all: it is read only as one entry nested inside the one scenario result that already covers it.

The `historyPath` setting makes the scenario history visible. It belongs in `allurerc.mjs`, which configures Allure 3, not nukadoko. Without this setting, Allure 3 does not build history for `generate`, `watch`, or `report`, even with a stable scenario `historyId`.
A project with a perfectly stable identity and no `historyPath` still sees no trend, no regressed/fixed transition, no flaky detection, and nothing in the report itself points at a missing config key as the reason.
`nuka init` writes it unconditionally into the `allurerc.mjs` it generates, pointing at `.nukadoko/export/allure-history.jsonl`, kept beside the disposable `allure-results/` directory rather than inside it, so clearing results between runs never discards it.
[`examples/allure/allurerc.mjs`](https://github.com/meganemura/nukadoko/blob/main/examples/allure/allurerc.mjs) carries the same field for a project not using `nuka init`.
Setting `historyPath` never makes a step entry's own history visible: a step entry has no identity to build one from in the first place.

A team that migrates an existing suite to nukadoko starts new Allure history, trends, and retry tracking. The previous tool computed history with a different `historyId` formula, which nukadoko deliberately does not reuse.
The compat door exists to let a suite move onto nukadoko, not to be where it settles.
Once on nukadoko, a scenario's history starts building fresh from nukadoko's own runs.

A step entry includes its trace, HTTP log, validated result, `record.json`, and declared attachments.
Data tables become CSV attachments named `Data table`.
Doc strings become text attachments, which preserves content that allure-cucumberjs omits.
An Examples table becomes a scenario attachment named `Examples`.
Scenario evidence, such as `final.png`, attaches directly to the scenario result.

Every step entry with a step record includes the complete record as `record.json`, whether the step passed or failed.
It is the same object that reached disk, already redacted there, so nothing here redacts it a second time.
It attaches whole rather than picked apart field by field, on purpose: a field added to `record.json` later shows up in the report on its own, with no emitter change needed to carry it there.
The individually mapped fields elsewhere in this section stay too, since a reader who wants one fact should not have to open an attachment to get it; `record.json` is the fallback that keeps the report complete where an individual mapping was never written.

A declared attachment carries a name prefixed `declared:`.
Once everything is sitting in the same result file, that prefix is the one place where provenance (measured by nukadoko versus self-reported by the step) survives.

Declared logs, measured timeline entries, and part calls appear as nested steps under their Gherkin step.

A step entry combines its `sections`, `polls`, and `actions` into one nested child-step timeline (see "Records"). The emitter merges them in ascending `at` order.
Two entries that land on the exact same millisecond keep a fixed order, sections before polls before actions, so a rerun of the same step record never reshuffles the timeline into an unreadable diff.
A section renders as a zero-width marker named after its own label.
A poll spans its own start through `waited_ms` later, named `<description> (<attempts> attempts)`: the duration alone cannot tell a wait that resolved on the first attempt from one that took forty, and the count is the one fact only the name can carry.
A poll's own outcome sets the child step's status: `resolved` is passed, `timed_out` is failed (the condition it waited for was never met, the step's own contract not holding), `failed` is broken (the poll's own callback threw, unrelated to whatever it was waiting for).
An action spans its own start through `ms` later, named after its own `method` plus, when the call carried one, its `selector` or `url` (e.g. `goto /orders`); an `expect` call is named with its matcher and target instead (e.g. `expect #late to.be.visible`, with `not` folded in for a negated assertion), since neither is implied by `method` alone the way a `goto`'s own target is implied by `url`.
Neither `ms` nor `timeout_ms` ever lands in the name: `ms` is already visible as the child step's own width, the same reason `page_events`'s observed counts stay off step names too, and `timeout_ms` stays in the `record.json` attachment.
When `actions` itself was capped at 100 entries (see "Records", `truncated.actions`), the timeline gets one more child step at its own tail, zero-width and passed, naming the cut (e.g. `... 4113 more actions not shown`), so a reader scanning only the timeline never mistakes a capped list for everything that happened.
Never clamped to the parent step entry's own start/stop range: a timeline entry outside that range already happened, and hiding it would make it unreadable rather than making it not true.

The emitter presents `page_events` as up to three parameters (see "Records"): `console errors (observed)`, `page errors (observed)`, and `failed requests (observed)`. It adds a parameter only when that category has an entry, so readers can see the count without opening `record.json`.
A category the collector truncated reports its true total beside the shown count, e.g. `100 of 4213`: the shown count alone would understate what actually happened.

A step entry's parameters carry its declaration and what was actually observed side by side: `mutates (declared)` next to the measured `http reads (observed)` / `http writes (observed)` (and, for a compat step, `world reads (observed)` / `world writes (observed)`), not because the two are checked against each other automatically, but so a reviewer can.
The declaration is what nukadoko trusts and acts on, the observed counts are what actually happened, and this row is where the two sit close enough to compare by eye.
The observed side is an HTTP-method proxy, not a semantic judgment (see "Keyword semantics"): a row can show a truthful `mutates (declared): false` next to a nonzero `http writes (observed)` when the step called a POST-based read, and that is the proxy showing through the table, not either number lying.

A failed scenario puts `[nukadoko.failure=<kind>]` in `statusDetails.message`.
It writes the original error message in `statusDetails.trace`.
The marker names the same `error.kind` a failed step's step record (or, when a hook stopped the scenario, that hook's own record) already carries, and the same `error.kind` is also written as a `nukadoko.failure` result label.
The two Allure generations turn that into a category by different paths, and they need different things from a user.

- **Allure 2** has no category field for each result, so the emitter also writes `categories.json` on every run.
  It contains all seven rules, one for each `error.kind`, and matches the message prefix by regular expression.
  The message prefix and category rule represent the same classification, so users do not need extra configuration.
- **Allure 3** does not read `categories.json` from a results directory during `allure generate` or `allure report`.
  Allure 3 gets categories only from its configuration and matches them against result labels.
  `nukadoko.failure` supplies that label.
  `nuka init` writes `allurerc.mjs` at the project root with seven label-matcher rules, one per `error.kind`, built from `NAME_BY_KIND` (`src/report/allure/categories.ts`) so the names can never drift from the ones the emitter itself uses.
  Dropped at a project's root it is picked up automatically (Allure 3 auto-detects `allurerc.{js,mjs,cjs,json,yaml,yml}` from the current working directory, no `--config` flag needed).
  `nuka init` checks all six extensions first and writes nothing, naming the file it found on stderr, when a project already has one.
  Without any of them, every nukadoko failure lands in Allure 3's one built-in "Product errors" category instead.
  A project not using `nuka init` can still copy [`examples/allure/allurerc.mjs`](https://github.com/meganemura/nukadoko/blob/main/examples/allure/allurerc.mjs) by hand.

Before and After hooks share one scenario-scope Allure container.
Each hook becomes a fixture with its trace, attachments, and child timeline.
A hook's own trace and `actions` attach to that hook's own fixture, mapped the same way a step entry's are: the trace as an attachment named `trace`, `actions` merged into the fixture's own child-step timeline through the same merge described above.
A hook carries no `sections`/`polls` of its own, since it has no fixture bag to call `section`/`poll` from; only its trace-derived `actions` still render.
A hook invocation that never touched `this.openPage()` gets neither: no trace attachment, no timeline entries, the same "nothing to show" a step entry that never touched the page already gets.
A Before hook failure makes the scenario result failed and leaves each planned Gherkin step skipped.
BeforeAll and AfterAll still have no run-level record that the emitter can map.
Hook duration still uses scenario boundaries because scenario records do not contain per-hook timestamps.

`allure-results/` is safe to read while `nuka run` is still going: every file lands through a temp-file rename, so a reader never sees a half-written result.
A scenario's one real result only exists once that scenario ends; what a live reader sees update before then is the progress snapshot below.

The emitter writes the first progress snapshot when a scenario starts.
This initial snapshot lists every planned step without a status, so Allure displays each step as unknown.
The emitter writes a new `<uuid>-<sequence>-progress-result.json` after each completed step.
Each snapshot uses the completed statuses and timings available at that point.

For a long-running step, the emitter also writes a snapshot every ten seconds between those two points.
That snapshot draws the running step with no status, a `stop` set to the moment it was written, and its live activity listed as child steps, one flat level deep.
Two sources feed those children, and both carry words a person wrote: a `ctx.poll` call still retrying contributes `waiting for: <description> (attempt N)`, and each `ctx.section` label reached so far contributes `section: <label>`.
A live child is redacted where it is built. Every other value on a snapshot arrives off a step record that was redacted when it was written, and a live child has no such earlier pass to inherit.

When a running step has neither activity to report, the emitter does not write a heartbeat snapshot.
A tick that could only say how long the step has been running would be telling a reader something they can already see, and paying a whole-page reload for it.
The consequence to know: a step that runs for a minute with no poll and no section looks exactly like a step that has not started.

The interval is ten seconds and is not configurable, since it answers how long a person waits before a live view reads as stalled, and that does not vary by project.
One step stops after 120 ticks. The bound exists because each tick spends a snapshot out of the `start` budget below, and because a step's own retry listing gains one row per snapshot it wrote.

All snapshots for one scenario share a uuid generated at scenario start, but each uses a new file name.
Both halves are needed. A detail page's route is a hash of the result's own uuid, so a moving uuid moves the route out from under any page already open on it, and `allure watch` discovers a new file path while ignoring a rewrite of one it has read.
Allure reads a result's uuid out of the JSON body rather than off the file name, which is what lets one value stay fixed while the other changes.

A snapshot has the final result's `historyId`, but excludes attachments, hook fixtures, and excluded context parameters.
Each snapshot gets its own `start`, one millisecond above the snapshot before it.
The first sits `stepCount * (121) + 2` milliseconds below the scenario start, so the last one still stays below it.
That budget covers one snapshot per step plus the 120 heartbeat ticks each step may add, since a formula sized for one write per step would run out the moment a step ran long enough to tick.
The final result keeps the scenario start, so Allure selects it as the canonical retry result.

Allure 3 merges files as retries when they share a `retryHash`, a hash over `testCaseId`, the non-excluded parameters, and the environment id.
`historyId` rides along on every snapshot for history and known-issue matching, and takes no part in that grouping.
Allure selects the result with the greatest `start` as canonical, and falls back to ingest order when two results share one `start`.
Distinct values per snapshot are what keep that fallback out of the decision.
Ingest order is safe to rely on under `allure watch` and unsafe under `allure generate`, which sorts the directory by file name and reads it concurrently.
This behavior was measured with Allure 3.14.3, the version this project pins, and confirmed in the `@allurereport/core` source.
The Allure README does not document this behavior.

The fixed uuid and the climbing `start` only work as a pair.
Every snapshot in a scenario resolves to one store id, so Allure records that id's ingest position once and reads the same value back for every later write.
Two snapshots tied on `start` would therefore tie on ingest position too, the comparison would return zero, and a stable sort would leave the earliest snapshot holding the canonical slot for the rest of the run.
Everything written after it, including whatever step the run had actually reached, would count as a retry and drop out of the scenario list.
A change to the `start` formula that lets two snapshots tie brings that back, even with the uuid scheme untouched.

Two measured limits remain under Allure 3.14.3.
A detail page opened during a watch session follows its scenario to the end of the run and then stops there: the real result lands on a route of its own, and a reload keeps the URL fragment, so reaching it means walking in from the list again.
The same page also tops out one step short of the end. A scenario of N steps writes N+1 snapshots, and the last one is written between the final step and the cleanup below, inside the 300ms the watcher waits between polls.

Allure appends to a result's retry list on every read without checking whether that id is already there, so a scenario's retry listing carries one row per snapshot it wrote.
The row count is the same one a fresh uuid per snapshot produced. What changed is that every row now opens the one page rather than a different frozen snapshot each.
Those rows exist only in a live watch session; a report generated from a finished results directory carries none of them.

During a live watch session, older unknown snapshots can appear in the running scenario's retries.
When the scenario ends, nukadoko writes the final result and removes that scenario's progress files.
At run start, it removes progress files left by an interrupted prior run.
This cleanup assumes one active run for each results directory.

Completed result files remain append-only. The emitter does not clear or replace an existing `allure-results/` directory.
Progress files are nukadoko work files and form the only exception.
Whether two `nuka run` invocations count as one Allure launch or two is left to the caller; a user who wants a fresh launch removes the directory themselves.
A completed results directory contains final results, containers, attachments, and launch metadata.

If a future Allure version changes retry merging, the live view can lose step-level fidelity.
The completed directory still contains only final results, so generated reports remain correct.

Ad-hoc `nuka do` records stay outside the dashboard.
An exploration becomes reportable when a feature records it and `nuka run` executes that scenario.

Allure displays each run; nukadoko has no web UI.
History, trend, and flakiness are Allure features too; per the identity paragraphs above, this emitter feeds them at scenario grain, once `historyPath` is set, and never at step grain: nothing about a later invocation links a step entry back to an earlier invocation's, only a scenario does.

Not yet built: link-template configuration for tags such as `@issue:123`.

The point is not format politics: a classic cucumber run fills an Allure report only where glue authors hand-attached evidence, while nukadoko's harness measures everything anyway, and Allure's own model (attachments, labels, parameters) already had a first-class place for all of it.
The Allure emitter is where nukadoko's measurement surplus becomes visible, automatically, today; the messages emitter below is the second, narrower output, and its job is compat fidelity rather than measurement surplus.

## Messages emitter

For each invocation, `nuka run` writes one cucumber messages stream through
`@cucumber/messages`. The stream uses NDJSON with one envelope per line and
defaults to `.nukadoko/export/messages.ndjson`. `messages.output` in
`nukadoko.config.ts` can set another root-relative path. Like Allure, this
emitter has no `enabled` or CLI flag. It runs unless the invocation selects
zero pickles.

- One run produces one stream in one file, and concurrent invocations use
  separate files. Each invocation's real file is the
  configured path's own name with the run id spliced in
  (`messages.<run_id>.ndjson` under the default path; `messages.output:
  "out/stream.ndjson"` gets `out/stream.<run_id>.ndjson` instead), beside
  the configured path; `begin`
  truncates that file, never the configured path, because appending would
  leave two `testRunStarted` envelopes in what must read back as a single
  well-formed stream, the same reason two concurrent invocations must
  never truncate one shared file between them (they used to: whichever
  began second erased the first's own start of stream while both still
  appended their own finish to it, a combination no single run can ever
  produce on its own). `end` then replaces the configured path with a
  full, atomic copy of this invocation's now-complete file, as its very
  last action, so a reader of the configured path never observes a
  half-written run: always either the previous run's complete stream or
  this one's, never a mix of the two.
- The configured path remains unchanged while a run is in progress. It
  changes once, when `end` places
  the finished copy. A crash mid-run leaves the previous run's own
  complete file at the configured path, never a truncated one; watching a
  run live is Allure's job (`npx allure watch`), not this stream's.
- Each invocation file remains beside the configured path.
  Nothing removes these files automatically, for the reason "Artifacts"
  gives for every other measurement artifact; `nuka clean [--export]`
  removes the accumulated ones along with the configured path's own copy.
- This emitter has the inverse role of the Allure emitter. Allure exposes
  nukadoko's measurement surplus, while this emitter preserves compat
  fidelity. Its only job is to ensure that a migrated suite's existing
  formatters and JUnit-based CI keep reading a nukadoko-produced run the
  way they read a classic cucumber-js one.
- Step record internals do not enter the stream. This excludes the validated
  result, `mutates`, `observed` counts, `error.kind`, and `calls`.
  `TestStepResult` and
  `TestStepFinished` are closed schemas (`additionalProperties: false`)
  with no field for any of them, and there is no smuggling them in through
  a marker the way Allure's own `[nukadoko.failure=<kind>]` label does.
  `calls` carries a second reason on top of that one: this format has no
  step inside a step, so a part would have no shape to take here even if
  the schemas were open (see "Parts"). Allure nests one because Allure's
  own model does.
- Attachments contain only what a step declared about itself: `declared`
  attachments and log lines. Log lines use cucumber-js's
  `text/x.cucumber.log+plain` media type (the one `this.log()` produces).
  Trace, screenshots, the HTTP log, and the validated result stay
  Allure-only: that measurement surplus already has a home, and
  base64-embedding a trace here would bloat the stream for no consumer
  that wants it.
- `testRunFinished.success` always matches the run's exit code.
  BeforeAll/AfterAll have no place to write into this stream (no
  run-scope record exists for the emitter to draw from), so a run whose
  run-scope hook failed shows up only here, never inside any one
  scenario.
- A real consumer confirms the stream's behavior, beyond its internal
  consistency. Passing nukadoko's `messages.ndjson` through
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

When an application change makes a scripted scenario stop matching
reality, use this repair loop:

1. An agent uses `nuka do` to run the goal adaptively, one step at a time.
   The agent reads each step record before it chooses the next call.
2. The step records capture the sequence that worked, including its
   differences from the scripted scenario. They describe the repair but do
   not prove it. The agent can cite this sequence in the PR.
3. The PR updates the typed steps, the feature file, or both. A green run of
   the repaired scenario supplies the proof through its scenario record and
   step records. Reviewers inspect those records like any other change.
   Attestation always passes through a scenario, not an ad-hoc sequence.

nukadoko records every stage. The bundled agent skill supplies the authoring
workflow; the engine does not repair scenarios by itself. Without an audit
trail, self-healing can silently remove what a test suite checks. The
deviation record prevents that loss from staying hidden.

## Tending

`nuka check` answers one question: can this project run right now. A
project can pass every check and still rot. A sign-off can stop describing
the code it froze. A declaration can remain unexercised for years. A
contract can be unreadable to the agent that must select it. These problems
do not stop a run, but each becomes more costly with time. This failure mode
gives the tool its name: a nukadoko matures with daily tending and dies from
neglect.

`nuka tend` answers the other question: are this vocabulary and its records
still healthy.

It is a separate command, rather than another set of `check` warnings,
because the two commands are read at different times and have different meanings.
`check` runs before every run, in CI, inside an agent's loop, and every
line it prints is something standing between the project and a green run,
so each finding must be worth stopping for. Tending findings are different:
nothing here must be fixed today, and if these findings appeared
on every `check`, they would teach everyone to skim past the line that
did have to be fixed. Noise is not a cosmetic problem in a tool whose main
claim is that users should read its checks.

Before listing findings, `tend` prints three summary lines that show the
bed's current state. None of the three is a finding, and none changes the exit
code (a suite in the middle of a migration is in a normal state, not a
faulty one, and warning about it every time would drown the findings that
do need acting on):

- `scanned:` names every directory that this run inspected:
  `featuresDir` plus each `additionalFeatureDirs` entry (see "Sessions,
  environments, secrets"). Printed first, because a count means nothing
  until the reader knows the scope of the count.
- `bed:` shows how much of the vocabulary is typed instead of compat,
  and how many typed steps declare `mutates: false`
  (read-only).
- `declared:` shows how much of a typed step's available declaration
  (`rationale`, a `.describe()` on each schema field) is actually
  declared.

This summary exists because the information was already available but unread. A step
record's `world` and `declared` counts do shrink as a suite promotes, which
is accurate but useless for showing progress: nobody reads a directory of
step records to calculate how far a migration has progressed. Stating it once in the
command devoted to the bed's health makes the information visible.

The following findings show what `tend` inspects and why each item is rot rather than style:

- **A sign-off that no longer matches the code it froze.** A record
  contains the accepted feature source and every step record from that run.
  If a frozen `result` no longer passes its step's current `returns`
  schema, or the frozen feature source no longer matches the file it was
  taken from, or a step it cites is gone from the vocabulary, then the
  record remains on disk with a claim it can no longer support. This
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
- **A sign-off's recorded condition drifting from the config.** A
  sign-off is scoped to a condition (see "Sign-off"): `(environment,
  browser)`, both measured, never declared. If the most recent sign-off for
  a feature recorded a browser the project's config no longer declares,
  nothing about that sign-off is wrong right now, which is why this is a
  note rather than an error, unlike the finding above. A record accepted
  before this note existed carries no condition to compare against at all,
  so this finding omits it instead of guessing. Like
  the finding above, this stops once the feature has moved into
  `featuresDir`: the drifting condition belongs to a claim nothing depends
  on any more.
- **A step file that failed to import.** `tend` uses the same tolerant
  step discovery as `nuka check` (see "Tolerant reporting, fail-fast
  execution"): a broken glue file is skipped rather than stopping the run,
  so whatever it would have contributed is silently missing from every
  count and finding here, not absent because nothing failed. One note for
  the whole run, not one per file: a broken file's own cause is `nuka
  check`'s own finding (`step-file-import-failed`), so this one only says
  how many steps went unseen and names the files, and does not touch the
  exit code.
- **A `from` declaration that nothing exercises.** Every occurrence of the step
  across every feature captures that key from the line, so the declared
  producer never supplies anything. Reported as the fact it is (the
  declaration may still be reached through `nuka do --use`), not as a
  instruction to delete it.
- **A step whose pattern no feature binds.** A step intended only for
  the CLI should have no pattern at all; one that has a pattern is
  claiming a place in a scenario it does not occupy.
- **A schema field with no `.describe()`.** This is the tending finding
  specifically for the agent: `nuka describe` is how an agent learns what
  a field means, and a field with no description tells it nothing a name
  did not already. Human readers of the step file can see the surrounding
  code; the agent choosing between two steps cannot.
- **A step with no `rationale`.** `description` says what the step does,
  which is enough to call it. `rationale` says why it is built this way and
  what was rejected, which is what an agent needs before deciding it may
  rewrite the step. Without it, every rewrite is uninformed.
- **A configured parameter type that no pattern uses.** This is dead
  configuration, reported like any other.
- **A `defineParameterType` still registered in support code.** It continues
  to work, and `config.parameterTypes` is its typed-era home; moving the
  registration changes no match. This one used to be a `nuka check`
  warning, but that classification was wrong: it appears for as long as a suite has any
  compat left, which is a normal state to be in, and printing it before
  every run trains people past the lines that do stop a run.
- **A `secrets.public` or `secrets.redact` entry that names a key no envFile
  defines.** The instruction is real but reaches nothing: configuration that has
  drifted from the files it describes. Also moved from `check` for the same
  reason: nothing about it changes whether this run should happen. Its
  neighbors stay on `check` and are worth the contrast: a `redact` entry
  whose value is too short to be redacted, and a tracked env file with a
  secret-looking key, both mean plaintext reaches a log the moment the run
  starts, which is exactly something to know beforehand.
- **A configured `additionalFeatureDirs` entry that is absent from
  disk.** It exists specifically to widen what `nuka check`/`nuka tend`
  scan, so an absent directory is a config mistake to report, the same way
  a missing `featuresDir` is, except `tend` has no error bucket for a
  config mistake the way `check` does, so this is a note here even though
  `nuka check` reports the identical fact as an error.
- **An accepted feature outside all directories that `nuka check`/`nuka tend`
  scan.** A sign-off record already proves that feature ran green, but a
  feature nothing here walks still leaves the steps it binds looking
  `pattern-unbound` to every other finding in this report. Sign-off
  records provide visibility for this finding only and never decide
  what gets scanned: growing the scanned set from them would only ever
  notice a feature that has already been accepted at least once, silently
  missing the one still being drafted: exactly the feature a false
  `pattern-unbound` would most mislead someone about. Naming the
  directory in `additionalFeatureDirs` is what actually fixes it.
- **A feature that no acceptance record has ever named**
  (`feature-never-signed`), the mirror of the finding above: that one
  starts from a record and asks whether it points to the right
  feature set, this one starts from the scanned feature set itself and
  asks whether any record exists for each member at all, so the two can
  never fire on the same feature for the same reason. A note, not an
  error: `nuka accept` is a later, explicit step in the acceptance loop
  (see "Sign-off"), so a feature still being drafted having no sign-off
  yet is the ordinary state, and treating that as broken would leave
  every feature in progress red until the day it is finished. No age
  threshold either, since "has this ever been signed" has one answer and
  "long enough to worry about" would need an invented one. Being inside
  `featuresDir` does not silence it, unlike the sign-off staleness
  findings above: those go quiet once the running suite carries the
  guarantee a frozen record used to, but whether a record was ever made
  is a different question, unaffected by where the feature runs.
- **Scenarios that begin with the same steps, and what the repetition
  cost.** A shared opening is ordinary: several scenarios about one page
  reasonably start by getting to that page. It turns into rot when the
  opening is expensive and nothing has been lifted out of it, because the
  cost grows with every scenario added. This finding is measured rather
  than read off the feature files. It groups the most recent run's
  scenario records by their leading step text, reads those steps' own
  records for what each took, and names the group, its steps, and the
  total. One finding per family, at the depth where the most time is
  spent, so one nested group is never counted again at three depths. Two
  gates keep it quiet: two scenarios at least, and at least 2% of that
  run's summed scenario time. That floor came from measuring a real
  suite, where it removed exactly the groups whose cost rounded to zero
  and gave up 0.2 of the 101.5 seconds the finding otherwise named. The
  denominator is summed scenario time rather than wall clock, so this
  reads the same at any `--concurrency`. A run still in progress is read
  as far as it has got, and its shares are of what it has written so far,
  since a scenario record carries no mark saying its run has finished. It
  stops at the number. What to
  do about a shared opening depends on which of those scenarios write to
  the state they share, which this tool cannot see, and the place to lift
  it into is a `process`-scope fixture (see "Fixtures"). Naming a saving
  would be claiming the lift is possible, which nothing here measured.
- **A step whose trace shows another call soon after a navigation
  call.** `tend` reads this from the tool's step records under
  `.nukadoko/records/steps/` (see "Records"). A committed sign-off record
  holds a copy frozen at accept time, so the live step record is the one
  that still carries what a run measured (see "Sign-off"). This reaches
  every step that still has a step record on disk, whether or not anyone
  signed it off: a step nobody has signed off yet already has a step
  record from the run that exercised it. For each `goto`, `reload`, `goBack`,
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
  changed. A step record with no `actions` at all, whether because the
  step never touched the browser or because it predates that field,
  silently remains out of scope and is not an error.

This last finding most clearly explains why the whole list belongs to
`tend` and not `check`. The step it names already ran, and its own step
record already measured that execution; nothing about it is broken today,
and no run is blocked by it. What changed is only that the tool can now
see a fact about how that execution went, not that the execution stopped
being real. `check` exists to answer whether a run can proceed right now,
so a step that already ran has nothing left for it to say; `tend` exists
to answer whether what already ran is still healthy, and "has not yet lost
a race it happens to be running" is exactly the kind of health that
question is for. Reporting this as an error would treat a symptom that has
not appeared as if it had.

Findings support `--json`, like the other output. The sign-off finding exits
non-zero so a periodic job can act on it; the rest do not, because a
project is allowed to carry them.

`tend` reports but does not repair. Repair means writing a description,
deleting a step, or re-accepting a feature: decisions with an author
behind them, which is the same reason `accept` refuses rather than
fixes up a dirty tree.

## CLI summary

The npm package is `nukadoko`. The one command it installs is `nuka`.

```
nuka run <feature[:line]|dir>...
                              execute scenarios; step records + allure-results.
                              :line runs one scenario, for iteration only. A
                              partial run can never be accepted. Each target
                              can be a file, file:line, or directory. Targets
                              form one deduplicated set in deterministic byte
                              order and one invocation: one run_id, one
                              summary, one exit code, one messages stream, and
                              one Allure results tree. :line on a directory is
                              refused, and a
                              directory with no .feature file anywhere under
                              it fails setup, naming what it walked. stderr
                              gets per-step/per-scenario progress as it runs,
                              then every location this run wrote and a summary
                              line. Each failed scenario follows with its
                              feature, line, and name. --quiet drops the
                              progress lines only.
                              stdout stays NDJSON, one record per scenario,
                              always.
                              --concurrency <n> (default 1) hands whole feature
                              files to n worker processes while the parent
                              keeps one run_id, one summary, one exit code, one
                              messages stream and one Allure results tree.
                              Above 1, stdout lands in completion order and the
                              progress lines are held per scenario. A file
                              tagged @serial runs while no other file runs.
                              --session drops it back to 1 and says so
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
                              comes from (from, or from_errors naming the
                              key and why for the one it can't read);
                              --json's top level is { steps,
                              import_failures }, the second always present,
                              exiting 1 if import_failures is non-empty or
                              any step's needs_error or from_errors is
                              present, output printed either way
nuka describe <step>          full contract, schemas as JSON Schema, plus
                              rationale when the step declared one, plus
                              import_failures beside it (same shape as nuka
                              steps' own); exits 1 when that array is
                              non-empty, or when the described step is typed
                              and carries its own from_errors; a broken
                              sibling step elsewhere in the vocabulary does
                              not fail it
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
nuka clean [--records] [--cache] [--export] [--dry-run] [--json]
                              delete accumulated records/cache/export under
                              the state directory; no category flag cleans
                              all three, one flag narrows to it; --dry-run
                              prints the same plan the real run would act on
                              without removing anything; refuses outright,
                              every category, while any session anywhere is
                              live; export/allure-history.jsonl is never
                              removed
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
                              directory, a feature no acceptance record has
                              ever named, a fixture no typed step requires,
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

Text output (no `--json`) is formatted for a human reading a terminal.
`--json` is the machine-readable contract.

### Tolerant reporting, fail-fast execution

A broken step file gets one of two different responses across this list.
The split follows one question: is the command about to execute a step, or
does it only report on the vocabulary? `nuka steps`, `nuka describe`,
`nuka check`, and `nuka tend` are reporting tools. Each discovers steps per
file, so one file whose import fails does not empty what the rest of the
project could still show. `nuka check` names the failure as
`step-file-import-failed`. `nuka steps`/`nuka describe` carry the same fact
as `import_failures` (above). `nuka tend` adds a single
`import-failures-unseen` note instead of silently under-counting around the
file it never read (see "Tending"). `nuka run`, `nuka do`, and `nuka init`
are about to execute a step, or set up a project that is about to, so they
stay fail-fast: the same broken file rejects the whole call outright,
because continuing past it is dangerous for anything about to run, not
merely report on. A migrating suite's normal state is some glue still
broken. A reporting tool that refused to run at all in that state would not
be a useful migration dashboard. An execution tool that pressed on anyway
would be running against glue it never actually read.

## Out of scope (honest limits)

- Semantic truth of a step's implementation rests on PR review. The tool
  guarantees the shape of inputs/outputs and the fact of execution.
- nukadoko cannot stop an agent with shell access from reading `.env`
  directly. It removes the structural necessity of secrets passing through
  the agent's context.
- A sign-off is not a proof that the software is correct. It records that an
  agreed scenario was green at one named commit, and says nothing about
  today. It does not even claim that same commit would be green now. A
  defect that depends on when the run happened (a date computed in one
  timezone and read in another, a boundary the clock crosses) is missing
  from the record exactly as it was missing from the run, and nukadoko does
  not re-run a frozen scenario to find out. The honesty is that a record
  only ever speaks about one execution. The limit is that a whole class of
  defect is invisible to any single one.
- **This package ships ESM and only ESM, on purpose.** `package.json`'s
  `exports` carries an `import` condition and no `require` one. There is no
  CommonJS build beside the ESM one, and neither is planned. A project whose
  own `package.json` has no `"type": "module"` still uses nukadoko, through
  files that are unambiguously ESM whatever that field says: its config as
  `nukadoko.config.mts`, its step files as `.mts`. That is what `nuka init`
  and `nuka scaffold` write once they see such a project. So nukadoko is
  imported from ESM either way, and what a CommonJS project gets is a way in
  rather than a second build to keep working. The cost is real and falls on
  an existing suite: glue already written as `.ts` there has to be renamed
  before it can be discovered. That is more than the one import specifier
  the compat door otherwise asks for, and `nuka check` names each file that
  needs it.

- **Promoting a step to `defineStep` is one-way.** The migration door's
  promise covers compat assets: switching the import back leaves a plain
  cucumber-js suite. `defineStep` has no import to switch back to. A
  promoted step's body still moves (it is written against Playwright's own
  objects, by the same choice stated below). Its schemas do not move,
  nor does its step record's `result`, `from` and the binding-order check
  reading it, nor every contract check built on those, and nothing here
  converts one back. Stated as a limit rather than a gap to close: the
  conversion is per-step and mechanical, and the import's reversibility
  exists to make adoption's first step cheap, not to make the typed side
  optional.
- **Not driver-agnostic, deliberately.** The `page` and `request` fixtures
  return Playwright's own `Page` and `APIRequestContext`, and the compat
  door hands migrating glue the same objects it already used. Wrapping them
  behind an interface of nukadoko's own would cost every capability the
  wrapper didn't think to expose. It would also replace a vocabulary users
  already know with one only this tool speaks: the opposite of writing
  through the official SDK. The exchange is that swapping in another driver
  later breaks the public API and the compat door together. That is
  accepted, not overlooked: rewriting step bodies from one driver's API to
  another is work an agent does well, while paying for portability up front
  would slow every change that isn't a driver swap. Revisit when the
  probability of that swap is measured to have risen, not before.
- No CI reporting, and no retry that discards a prior attempt's record. No
  outbound network I/O by nukadoko itself. No HTML rendering: that is
  Allure's job. Scenarios do run in parallel (`nuka run --concurrency
  <n>`, see "Scenarios"), but only across worker processes inside one
  invocation. There is no flag that splits one suite across several
  invocations, because a suite whose records are spread over several run
  ids is one `nuka accept` cannot read as a single run.

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
  CLI is deliberately a set of small verbs. A skill turns them into a
  workflow an agent can follow without being told, and none of it changes
  the engine. Skills follow the Agent Skills specification, so `gh skill
  install` and a Claude Code plugin marketplace both distribute them across
  hosts. nukadoko does not copy files into any host's directory itself.
  `nuka skill path` exists for the one thing neither of those can offer:
  the skill that shipped with the installed nukadoko, at the version that
  installed it. A skill describes a CLI and drifts into fiction when the two
  diverge. Two ship. The **acceptance skill** drives the acceptance loop
  end to end: criteria in, vocabulary read with `steps` and `describe`,
  missing operations scaffolded and implemented, the scenario written, then
  `run` until green and `accept`. The **migration skill** carries what the
  compat audit measured: the gaps a real cucumber-js suite actually hits,
  in the order they bite rather than the order they are documented. Its
  first stage leans on `nuka check` reporting those gaps, which `nuka
  check` now does (see "Compat steps"). Neither skill writes down a fact
  the CLI already answers (vocabulary, contracts, refusal reasons), because
  a skill that copies those starts lying the moment the command changes.
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
  findings that come with them. This closes the one gap the typed side had
  that compat's After hooks did not: a place to put cleanup that is not
  itself an acceptance condition.
- **M9 (parts)**: `parts` on `defineStep`, the `call` fixture, the `calls`
  entries a step record gains, and the checks that come with them (see
  "Parts"). A step can be split without its feature file being rewritten.
  This is what makes a reuse granularity smaller than a scenario line
  possible at all.
- **M10 (harvesting)**: `nuka harvest`, one feature draft built from a
  named `do` sequence (see "Harvesting"). This is the move that closes the
  adaptive loop: a path found by exploring becomes a path fixed in a
  sentence, and a fixed sentence is the only form anything here can gate on.
- **M11 (live sessions)**: `nuka session start`/`stop`, one `ctx` held
  open in a process so `nuka do` can land on a world that is already
  partway through (see "Live sessions"). Everything before this started
  from nothing, which is merely slow for reads but impossible for work
  that cannot be repeated.
- **M12 (concurrency)**: `nuka run --concurrency <n>`, worker processes
  each holding whole feature files, `@serial` for a file that has to run
  alone, and the parent that keeps the run's identity while they work (see
  "Scenarios"). Every scenario still runs under the same serial engine;
  what changes is how many of them run at once. Worker processes make the
  gain independent of what a suite spends its time on, and leave the
  fixture teardown rule standing.
- **Later**: AI-assisted glue converter (existing regex glue → typed steps),
  tag-expression filtering, cucumber-js adapter if a real suite needs
  in-place coexistence rather than migration.

## Implementation notes

- Runtime dependencies: `@cucumber/gherkin`,
  `@cucumber/cucumber-expressions`, `@cucumber/messages`,
  `allure-js-commons`, `playwright`, `zod`, `tsx` (runtime TS import),
  `yargs` (CLI). Node >= 20.
- When a format or protocol has an official SDK, nukadoko writes through it
  rather than reimplementing the format. Allure results go through
  allure-js-commons' reporter machinery; cucumber messages go through
  `@cucumber/messages`. nukadoko stays a thin mapping layer on top.
  Overriding a piece of the official machinery is a measured decision taken
  when a concrete need appears, never the default.
- id format: `<kind>-<timestamp>-<short random>`.
- `nuka steps` and `nuka describe` import step modules, because collecting
  compat registrations and patterns requires it, and importing executes a
  file's top-level code, the same caution as running. Shell completion never
  imports: typed step names complete from file names, and ids and session
  names complete from the state directory, so TAB stays fast regardless of
  vocabulary size.
- The first real-world validation gate, before M2 was designed in detail,
  bound about 10 real feature files and measured whether reviewing
  AI-drafted typed steps actually beats writing glue by hand. It ran
  against 11 feature files from seven public projects, and the answer was
  yes in six of the seven. The second gate measured the compat door rather
  than the typed one, and is reported under "Compat steps" above.
