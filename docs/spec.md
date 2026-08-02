# nukadoko specification

> nukadoko — a living pickling bed for your Gherkin: typed steps, receipts, and an agent-first CLI.

Status: M1 (engine core) implemented — `steps`/`describe`/`do`/`run`/
`check`/`init`/`scaffold`, sessions, environments, secrets. M2 (compat,
below) is implemented too — `nukadoko/compat`, typed World measurement, and
a migration guide. Both real-world gates have now been run — typed steps
drafted against real feature files, and the compat door audited against
real cucumber-js glue (below). Pre-0.1; of M3+, the Allure emitter is
implemented, while the messages emitter and sign-off exist only as design.

## What nukadoko is

nukadoko is an agent-first engine that runs Gherkin. Humans write and review the durable
artifacts — feature files, typed step definitions, sign-off records — and
agents execute them. Everything about the runtime is optimized for an agent's
trial-and-error loop: every step has a typed contract, every step can be run
on its own from the CLI, and every execution leaves a receipt the agent
cannot forge.

Agent-first is a design constraint, not a slogan. An agent must be able to
complete the whole loop unassisted: discover the vocabulary
(`nuka steps --json`), read a contract (`nuka describe`, schemas as JSON
Schema), execute one step (`nuka do`, receipt on stdout, meaningful exit
code), read the validated result, and decide the next call. When the
vocabulary lacks an operation, the agent scaffolds and implements a new step
and a human reviews the PR. Every interface prefers machine-readable output;
human prettiness is delegated to Allure.

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
  contract; the mapping is statically checkable (`nuka check`).
- A data table or docstring attached to the step binds to the one required
  args key the named captures left unconsumed (tables as `string[][]`,
  docstrings as `string`), validated by the schema like everything else —
  Gherkin tables get types for the first time. Zero or several unconsumed
  required keys with an attachment present is a `check`/`run` error; no
  reserved key name exists.
- `mutates` (default `true`): whether the step changes state anywhere it
  touches. Read-only steps declare `mutates: false`.
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
- `await ctx.request()` — Playwright APIRequestContext with the configured
  baseURL and the session's cookies.
- `ctx.env` — environment variables from the configured envFiles
  (read-only). Not a convenience: it is where determinism (the process
  environment is never merged) and secrets redaction (only values nukadoko
  itself loaded are redactable) are enforced.
- `ctx.baseURL` — the configured baseURL, for the occasional URL assembled
  by hand; the common paths get it wired in above.
- `ctx.resultOf(stepModule)` — the validated result of that step's most
  recent successful execution in the current scenario; `undefined` under
  `nuka do` or when the step hasn't succeeded yet. This is the scenario
  path's data channel, and it is deliberately not a World: nothing can be
  written to it, only results that passed their `returns` schema can be
  read from it, and the dependency is a visible `import` of the other step
  module — typed by that step's own schema, reviewable in the diff. A
  feature line like "that listing is closed" is implementable exactly to
  the extent its referent produced a validated result.

Helpers live as imports: `import { poll } from "nukadoko"` gives the
submit-poll-fetch loop for asynchronous jobs — it needs nothing the
executor owns, so it is not on `ctx`. There is no `ctx.section` yet for
the inverse reason: it would do nothing today, and an API member that
does nothing is an unvalidated promise. It returns with the progress-log
feature, where naming a stretch of a run becomes something the tool
records.

### Keyword semantics

Gherkin keywords stop being decoration — not because declarations are
trusted, but because the tool measures. Real corpora forced this split:
the same sentence legitimately appears in both Action and Outcome
positions, idiomatic suites chain actions after `Then` via `And`, and a
step wrapping an arbitrary command has no single truthful `mutates` value.
A per-step boolean cannot carry a per-occurrence fact, so enforcement is
layered:

- `mutates` stays as the step's **declared intent** (default `true`;
  read-only steps declare `false`).
- **Statically**, `nuka check` warns — not errors — when a declared-
  mutating step is bound in Then position. The tension deserves human
  eyes, but the declaration alone cannot settle it.
- **At run time**, the receipt records what the execution actually did:
  every network call the tool saw (through `ctx.request()` and the page
  alike), with non-GET/HEAD calls counted as observed writes. A step
  executing in Then position whose execution observes writes fails — per
  occurrence, measured, regardless of what was declared.
- Gherkin classifies an `And`/`But` step by inheriting the pickle step type
  of the preceding primary keyword (Given/When/Then) — gherkin's own
  pickle-compilation behavior, not a nukadoko choice. An action chained
  after `Then` therefore runs under Then-position observation: fine while
  it only reads, failed the moment it writes.
- Read-only environments refuse declared-mutating steps before execution
  and additionally fail any execution that observes writes — a false
  `mutates: false` cannot slip through the policy.
- Honest limits: observation sees network writes only. Purely client-side
  state and a server that mutates on GET are invisible to it; the
  declaration and PR review still carry those.
- Compat (untyped) steps cannot be checked statically; run-time
  observation applies to them unchanged.

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
  API is the commonly used subset (Given/When/Then, World, Before/After);
  it grows on demand, not speculatively.
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
  and their network traffic sits outside any step's boundary.
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
  receipt, single-step CLI execution, and Then enforcement. Promoting a hot
  step to `defineStep` is the upgrade, one step at a time.
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
scenario's own directory, not on any single step. Then-position
enforcement applies at run time by observation: a Then-positioned
execution that observes network writes fails (see Keyword semantics).

An undefined step fails the scenario naming the text that failed to match
and suggests `nuka scaffold`. An agent following the bundled skill authors
the missing typed step and submits it as a PR — the feature backlog drives
vocabulary growth.

### Single steps (the agent path)

```sh
nuka do create-project --args '{"name":"acme"}' [--env <name>] [--session <name>]
```

Executes one typed step and prints its receipt to stdout (exit 0 on ok, 1 on
failed). This is the adaptive loop: the agent reads the validated result and
decides the next call. The agent can only choose which step to call with
which args; it cannot choose what gets recorded. There is deliberately no
grouping label on `do`: ad-hoc sequences are working records, not evidence —
anything worth attesting to is expressed as a scenario and proven by
`nuka run` (see Self-healing).

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
  `then_mutated`, `read_only_violation`, `timeout`, `unsupported`,
  `step_error`. Closed because a report has to classify against it — an
  open one, extended per step, would classify nothing. The first six name
  failures that exist only because there is a contract to violate, which
  is the part a report built on a runner that discards return values
  cannot fill in; a classifier that isn't sure says `step_error`, since
  claiming a contract failure wrongly is worse than not claiming one. Hook
  records in the scenario record carry the same field.
- `mutates` is the step's own declaration (`null` for a compat step, which
  has none to record — not `false`), sitting beside the `observed` counts
  so declared and measured can be compared without a second artifact.
- Evidence is collected by the harness, never reported by the step: Playwright
  tracing and screenshots when the browser is used, every `ctx.request()`
  call logged to http.jsonl, the receipt itself as the primary record.
- `observed` counts the network calls the tool itself saw the execution
  make, through `ctx.request()` and the page alike; non-GET/HEAD counts as
  a write. It is what run-time keyword enforcement and read-only
  environments act on — measured, never declared (see Keyword semantics).
- `used` (present only when non-empty) lists the receipt ids whose results
  this execution actually read through `ctx.resultOf` — the accessor is
  tool-provided, so the reads are measurable. The dependency is thus
  visible twice: statically as an import, at run time as provenance in the
  receipt chain.
- Receipts live under the state directory (`.nukadoko/`, gitignored). They are
  local working records; the durable artifacts are sign-offs.

## Sessions, environments, secrets

The execution infrastructure Cucumber never had:

- **Sessions** carry login state across CLI calls as Playwright storageState,
  stored per environment, advisory-locked to one run at a time. No `--session`
  means a clean start; there is no implicit shared state. No daemon.
- **Environments** name deployment targets: per-environment `baseURL`,
  `envFiles`, `policy: "read-only"` (refuses mutating steps), and an optional
  `version` probe recorded on every receipt as `target_version`. Sign-off
  machine-checks that cited receipts share one environment and version.
- **Secrets**: git is the classifier. An env file git does not track —
  ignored or untracked — is a secret source: every value it defines is a
  secret, no declaration needed. Tracked env files are plain configuration
  (a committed value is not a secret, and nukadoko will not pretend
  otherwise). Outside a git repository every envFile is treated as a secret
  source. Individual keys can be demoted in config
  (`secrets: { public: [...] }`); there is no manifest file and no
  promotion. Secret values are redacted (`{{secret.NAME}}`) wherever a
  receipt is emitted — receipt.json, `do`'s stdout copy, http.jsonl —
  applied by the executor at write time, never controllable from a step's
  `run`. Honest limits: values shorter than 4 characters are never
  redacted, and only values nukadoko itself loaded are redactable — a fresh
  token inside a step's result is not caught. Traces and screenshots are
  not redacted; the state directory is sensitive. `nuka check` reports each
  env file's classification and secret-key names (never values).

Configuration lives in `nukadoko.config.ts` (`defineConfig`): `featuresDir`
(default `features`; feature files and step code both live under it,
Cucumber-style), `baseURL`, `envFiles`, `environments`, `stateDir` (default
`.nukadoko`), `browser`, `secrets`, `parameterTypes`, `allure` (only
`resultsDir`, see "Allure emitter").

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

- `receipts/<id>/` — one directory per receipt: the receipt JSON, its
  evidence files (trace.zip, screenshots, http.jsonl), and the progress log
- `scenarios/<id>/` — one directory per scenario run: `record.json` plus
  the scenario-scoped evidence (trace.zip, final screenshot) — mirroring
  Playwright's own per-test `test-results/` convention one level up
- `sessions/<env>/<name>.json` — storageState; live credentials in
  plaintext, created with restricted permissions
- `allure-results/` — the emitter's output, appended to across runs and
  safe to delete whenever a fresh Allure launch is wanted

The durable artifacts live in the repository instead: feature files, typed
steps, and sign-off records.

## Sign-off

A sign-off turns "the criteria are met" from a claim that evaporates in
conversation into a recorded, reviewable artifact:

```sh
nuka signoff create \
  --criteria 'A project can be created and looked up by id' \
  (--receipts <id,...> | --scenario <feature:line>) \
  --reasoning 'create-project returned ok; get-project returned the same name'
```

- Machine checks at creation: every cited receipt exists, is ok, shares one
  environment and (when probed) one `target_version`. Citing a scenario
  additionally checks the scenario record: every step ran ok, in order.
  The scenario citation is the primary form — a reviewed feature that ran
  green; explicit receipt ids cover the ad-hoc rest.
- The reasoning — why these facts prove those criteria — is judgment. nukadoko
  does not evaluate it; it preserves it for human review, permanently
  separated from the facts it cites.
- There is no plan subsystem. The question "what would prove this?" is
  answered by the feature file and the typed steps it binds to, and both are
  approved the git-native way: PR review, CODEOWNERS, merge. A sign-off is
  the record that the agreed check actually ran.
- Sign-off records are small structured files meant to be committed
  (default `docs/acceptance/`). Git history carries how verification evolved;
  a CI tripwire ("fail a product PR when nothing under docs/acceptance
  changed") keeps the recording habit alive.

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
  reads (observed)` / `world writes (observed)`) — declaration and
  measurement, in the same table, is nukadoko's whole claim made visible in
  the report itself.
- A failed step or test's message is prefixed `[nukadoko.failure=<kind>]`,
  naming the same `error.kind` its receipt already carries; the same
  `error.kind` is also written as a `nukadoko.failure` result label. The two
  Allure generations turn that into a category by different paths, and they
  need different things from a user.
- **Allure 2** has no per-result category field, so the emitter also writes
  `categories.json` (one rule per `error.kind`, all nine, every run,
  matching the message prefix by regex) — the message prefix and the
  category rule are two views of the same classification, and no user
  configuration is needed.
- **Allure 3**'s `allure generate`/`allure report` never read a results
  directory's `categories.json` — categories there come only from Allure 3's
  own config, matched against a result's labels, and `nukadoko.failure` is
  exactly such a label. `examples/allure/allurerc.mjs` ships nine
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

Not yet built: the cucumber messages protocol emitter (NDJSON,
`@cucumber/messages` — already a dependency; every modern cucumber
formatter consumes messages, so the official HTML report, JUnit XML for
CI, and third-party consumers would come for free once it exists), a
hook's own duration (record.json carries no per-hook timestamp today, so a
hook's start and stop both collapse to the scenario's own boundary),
BeforeAll/AfterAll (no run-level record exists for the emitter to map
from), and link-template configuration (mapping a tag like `@issue:123` to
a URL).

The point is not format politics: a classic cucumber run fills an Allure
report only where glue authors hand-attached evidence, while nukadoko's
harness measures everything anyway — and Allure's own model (attachments,
labels, parameters) already had a first-class place for all of it. The
Allure emitter is where nukadoko's measurement surplus becomes visible,
automatically, today; the messages emitter above will be the second,
narrower output once it exists.

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

## CLI summary

The npm package is `nukadoko`; the one command it installs is `nuka`.

```
nuka run <feature[:line]>     execute scenarios; receipts + allure-results
nuka do <step> --args '<json>' execute one typed step; receipt to stdout
nuka steps [--json]           list the whole vocabulary, typed and compat:
                              name, patterns, description, mutates
nuka describe <step>          full contract, schemas as JSON Schema
nuka scaffold <name>          typed step template that fails until implemented
nuka check                    static checks: pattern/schema mismatches, Then
                              binding to mutating steps, undefined steps per
                              feature, duplicate patterns, config coherence
nuka signoff create|list|show verification records
nuka session list|clear
nuka init [--base-url <url>]  set up a project; ends with a self-check
nuka skill path|install       install the agent-facing skill
```

## Out of scope (honest limits)

- Semantic truth of a step's implementation rests on PR review. The tool
  guarantees the shape of inputs/outputs and the fact of execution.
- nukadoko cannot stop an agent with shell access from reading `.env` directly;
  it removes the structural necessity of secrets passing through the agent's
  context.
- A sign-off is not a proof; it is a durable, reviewable record of a judgment.
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
- **M4 — sign-off**: records, machine checks, CI tripwire recipe.
- **Later**: AI-assisted glue converter (existing regex glue → typed steps),
  scenario harvesting (generate feature files from recorded `do` sequences),
  tag-expression filtering, cucumber-js adapter if a real suite needs
  in-place coexistence rather than migration.

## Implementation notes

- Planned runtime dependencies: `@cucumber/gherkin`,
  `@cucumber/cucumber-expressions`, `playwright`, `zod`, `tsx` (runtime TS
  import), CLI framework TBD. Node >= 20.
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
