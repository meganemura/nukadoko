# Migrating a cucumber-js + Playwright suite

For teams with an existing cucumber-js suite running against Playwright,
feature files and step definitions living under `features/` (cucumber-js's
own layout convention, and nukadoko's default too). No rewrite: the goal is
to run the suite, unchanged, on nukadoko's harness, then promote pieces at
your own pace. An existing suite can be CommonJS (no `"type": "module"` in
its own `package.json`); this door works there too, using `.mts` in place
of `.ts` for both nukadoko's config and its step files (Stage 0 below). For
a full worked example of every stage below, with real captured command
output, see
[examples/migration](https://github.com/meganemura/nukadoko/tree/main/examples/migration).

Nothing below applies if there is no cucumber-js suite to begin with. A
project already running Playwright Test directly, with no feature files and
no glue to switch, starts from a different door instead: see
[docs/migration-playwright-test.md](migration-playwright-test.md). A suite
already shaped as typed steps, in a DSL of its own, starts at
[Coming from a typed-step DSL](#coming-from-a-typed-step-dsl). Whatever the
starting point, [Working rules](#working-rules) holds on every path; an
agent doing the migration reads it before the first change.

## Stage 0: install and point nukadoko at your suite

Install nukadoko, then run `nuka init` (or hand-write `nukadoko.config.ts`)
from the project root:

```ts
import { defineConfig } from "nukadoko";

export default defineConfig({
  featuresDir: "features", // point this at your existing features/
});
```

The app under test goes in a second file, `nukadoko.program.ts`. A suite
that starts the app itself today (a `BeforeAll` hook, a shell script, a CI
step) moves that recipe there, and nukadoko starts the app on a port of its
own for each run and stops it after:

```ts
import { defineProgram } from "nukadoko";

export default defineProgram({
  serve: { command: "npm start", ready: "/" }, // how the app under test starts
  env: { PORT: "{port}" },
});
```

A suite that runs against an app someone else starts writes
`url: "http://localhost:..."` there instead of `serve`. "Program" in
docs/spec.md has every field.

In a CommonJS suite, `nuka init` writes `nukadoko.config.mts` instead
(same content, and it says so on stderr); step files need the same `.mts`
extension there. Under `"type": "commonjs"`, Node reads a plain `.ts` file
as CommonJS, and nukadoko is ESM-only, so a hand-written
`nukadoko.config.ts` fails to import. The error names that file and the
cause, and, because the file is `.ts`, says to rename it to `.mts`. With no
`"type"`, Node loads a `.ts` file only after it parses it again, with a
`MODULE_TYPELESS_PACKAGE_JSON` warning on every load.

`nuka init` refuses to run if `nukadoko.config.ts` or `nukadoko.config.mts`
already exists, creates `<featuresDir>/steps/`, adds `.nukadoko/`, `.env`, and `.env.*` to
`.gitignore` (with `!.env.example` to keep the example tracked), and ends with a self-check that discovers the (still empty)
vocabulary. `featuresDir` defaults to `features` (cucumber-js's own
convention), so most suites need no override; discovery walks the whole
directory, so step files living elsewhere under it
(`features/step_definitions/`, `features/support/`) need no reshuffling
either.

A cucumber-js suite that reads `this.parameters` was given that object by
`worldParameters` in its cucumber.js profile, or by `--world-parameters`
on the command line. Put the same object on `worldParameters` in
`nukadoko.config.ts`. The World constructor receives it as `parameters`.
The default is `{}`. There is no command line flag for it: the config key
is the only place the object is set.

```ts
export default defineConfig({
  worldParameters: { baseUrl: "http://localhost:..." },
});
```

## Stage 1: switch the import

Change the one import your step files use:

```ts
// before: import { Given, When, Then } from "@cucumber/cucumber";
import { Given, When, Then } from "nukadoko/compat";
```

Everything below that import keeps working, unchanged, except for the
differences listed under [Known limits](#known-limits):

- string and RegExp patterns, matched exactly as cucumber-js matches them
  (no named-capture requirement: that discipline belongs to typed steps).
- both registration shapes: `Given(pattern, fn)` and
  `Given(pattern, { timeout }, fn)`, with that timeout honored.
- a `World` (`this`); `Before`/`After` hooks written any of the three ways
  cucumber-js accepts (`Before(fn)`, `Before({ tags }, fn)`, or the
  bare-string `Before("@tag", fn)`), filtered by a single `@tag` or
  `not @tag`; custom `setWorldConstructor` subclasses. A hook receives
  cucumber's hook parameter, so `Before(function ({ pickle }) {...})` works
  as written. `After` receives `result.duration`, and `result.message` and
  `error` when the scenario failed. `AfterStep` receives those too, plus
  `pickleStep` and `testStepId` for the step that just ran.
- `this.attach` in cucumber-js's forms: a string, including
  `base64:<media type>` (decoded into the file), a buffer,
  `{ mediaType, fileName }`, and a readable stream. A stream returns a
  promise, so the step awaits it. `this.link` takes one or more URLs, one
  declared link each. A second argument is another URL, not a name.
- A custom World constructor that throws fails that scenario. stderr gets
  one setup line, the scenario record is failed and cites no step record,
  later scenarios in the same run still execute, and the messages export
  is finalized.
- `{ name }` on `Before`, `After`, `BeforeAll`, and `AfterAll`. The string
  is stored and used as the hook's title. It does not change which
  scenarios run, the timeout, or the order. `AfterStep` does not accept
  `name`. `BeforeAll` and `AfterAll` still reject `on`, because that option
  chooses which process runs the hook.
- `AfterStep`, registered the same three ways as `Before`/`After`. It runs
  once per step that actually executed in the scenario, not once for the
  whole scenario the way `Before`/`After` do: a step this scenario skipped
  because an earlier one already failed never began, so `AfterStep` doesn't
  run for it either: there is no "after" for a step that never started.
- `Status`, cucumber-js's own `TestStepResultStatus` enum, re-exported under
  the same name: `result.status === Status.FAILED` inside a `Before` /
  `After` / `AfterStep` hook now imports and compares correctly.
- `DataTable` (`raw()`/`rows()`/`hashes()`/`rowsHash()`/`transpose()`): a
  step calling `table.hashes()` keeps working exactly as written (zero
  friction, measured migrating examples/migration's own suite).
- `allure.*` calls (`attach`/`log`/`link`, labels, parameters) inside
  glue: they land in the step record's `declared` field, not vanishing.
- `setDefaultTimeout(ms)`, filling in for any step or hook that didn't
  declare its own timeout, last call winning as in cucumber-js. A negative
  value means no timeout, including `setDefaultTimeout(-1)` and a step or
  hook `{ timeout: -1 }`. Zero still times out. Never calling it leaves
  steps unbounded rather than adopting cucumber's 5-second default: a suite
  shouldn't start failing for slow steps because it migrated.
- `BeforeAll` / `AfterAll`, bracketing the whole run, with `{ timeout }` if
  you pass one. They run only when at least one scenario was selected, take
  no `tags`, and get no World (`this`): none exists yet when `BeforeAll`
  runs. `BeforeAll` stops at its first failure and no scenario runs;
  `AfterAll` is attempted anyway, every registration runs even if a sibling
  threw, and teardown unwinds in reverse registration order.

### What the switch does not carry

Eight public cucumber-js suites were audited against this door, their glue
read as text and never run. **When that audit ran, none of them went
through on the import switch alone.** Supporting the most common blockers
it found has since brought two of the eight to where nothing in their glue
is rejected any more; the other six still need a short pass first. (Read as
a static claim, which is what it is: their glue no longer contains anything
this door turns away. Nobody ran those suites.) Everything below fails
loudly, but not all at the same moment: some of it `nuka check` already
names before you run anything, some of it only surfaces on the first
`nuka run` that reaches the step: each item below says which, so the pass
is a list you can work through, not a hunt. A difference that changes a
value without a failure is not on this list. [Known limits](#known-limits)
lists the measured ones.

- **`setParallelCanAssign`, used as a value**: `nukadoko/compat` does not
  export it. An ES module's named import is resolved at link time, so
  importing it and calling it takes the whole import statement (and with
  it the file) down; split the import or drop the call. Caught before
  anything runs: `nuka check` reports the file as `step-file-import-failed`,
  carrying Node's own error message; if `check` was skipped, the same
  failure surfaces on the first `nuka run` that tries to import the file.
  This name stays unsupported by decision because `setParallelCanAssign`
  decides which pickle a worker may receive. nukadoko distributes whole feature
  files, so its worker assignment has no pickle-level decision for this
  callback to control. Declare file-level mutual exclusion with an
  `@nukadoko:serial` tag on the feature. Accepting the call as a
  no-op would be worse than refusing it: it would import cleanly, run, and
  leave a suite believing its parallel-assignment rule was in effect while
  nothing enforced it, exactly the quiet failure this door exists to refuse
  (docs/spec.md "Compat steps (the migration door)"). Failing at the import
  instead keeps that promise, the same way every other name on this list
  fails. `nuka run --concurrency <n>` is what hands those whole feature
  files to worker processes.
  (`AfterStep`, `Status`, `BeforeAll`, `AfterAll` and `setDefaultTimeout`
  were on this list when the audit ran and are now supported; see above.)
- **The same kind of name, used only as a type** is a different case, not a
  smaller version of the one above, and it depends on how the import is
  written. Node loads glue by type stripping, which erases an `import type`
  (or an inline `type` name) and keeps every other import. Written with
  `type`, nothing by that name is imported at run time: neither `nuka
  check` nor `nuka run` sees anything wrong, and only `tsc` complains,
  which is `tsc`'s job. Written without `type`, the import stays, and the
  file fails with Node's "does not provide an export named" error, which
  `nuka check` reports as `step-file-import-failed`; for a type that
  `nukadoko/compat` exports, the finding says so. Add `type` to such an
  import; `"verbatimModuleSyntax": true` makes `tsc` find every one.
  cucumber-js glue often imports `IWorldOptions` beside `World` without
  `type`, so this is worth a search before the first run. (`IWorldOptions` and
  `ITestCaseHookParameter`, the audit's own examples of this category, are
  now exported, aliases for `WorldConstructorParams`/`HookParameter`, and
  typecheck the same as any other compat name.)
- **CommonJS glue**: nukadoko is ESM-only. Extension decides how discovery
  treats a file: `.ts`, `.mts`, `.js`, and `.mjs` are all walked and
  imported now (a suite written entirely in plain `.js`, not just `.ts`, is
  no longer invisible to discovery the way it used to be); a `.cjs` or `.cts`
  file is walked far enough to be named, never imported at all, so it never reaches
  an import to fail -- `nuka check` reports it as
  `step-file-unsupported-extension` instead. Inside a file discovery does
  import, `require("nukadoko/compat")` still fails outright with
  `ERR_PACKAGE_PATH_NOT_EXPORTED`, the same as it always has: an extension
  alone does not make a file's own code ES module glue. Two of the eight
  suites are CommonJS throughout; the door admits ES module glue only.
  Caught before anything runs either way: `step-file-unsupported-extension`
  for a `.cjs` or `.cts` file, or `nuka check`'s `step-file-import-failed` (or the
  first `nuka run` if `check` was skipped) for a `require()` call inside a
  file discovery does open.
- **Deep subpath imports** such as
  `import DataTable from "@cucumber/cucumber/lib/models/data_table"` have no
  equivalent here; import `DataTable` from `nukadoko/compat` instead. Caught
  the same way: `nuka check`'s `step-file-import-failed`, or the first
  `nuka run` if `check` was skipped.
- **A hook's tag expression beyond a single `@tag` / `not @tag`** (`and`,
  `or`, parentheses). `nuka check` reports every violating hook up front
  (`unsupported-hook-tag-expression`); `nuka run` enforces the same rule but
  stops at the first one it hits, since a run exits rather than lists.
- **Returning `"pending"` or `"skipped"`** from a step or hook fails with a
  message naming what to write instead. This is not visible to `nuka check`:
  it is a property of what the function does when it actually runs, not of
  how its file imports, so nothing before that execution can name the fault.
  It surfaces on the first `nuka run` that reaches it.
- **Done-callback glue** (`function (arg, done) {...}`) fails with the same
  kind of message, and `nuka check` reports it first as `done-callback-arity`.
  A hook is over the limit when Before, After, or AfterStep declares two or
  more parameters, or when BeforeAll or AfterAll declares one or more. A
  matched compat step is over the limit when its function declares more
  parameters than the line's captures plus a table or docstring. An
  unmatched step stays silent, because the capture count comes from the
  line that selected it. cucumber-js gives both the return strings and the
  callback meaning; nukadoko does not, and says so rather than passing the
  step.

Run the suite with `nuka run features/your.feature`. Every step gets a
step record; nothing else has to change for that to start happening.

## The measured upgrade (optional)

Glue that launches its own Playwright browser or request client keeps
working, with no trace and no page log: nukadoko does not hand it a
context. A request a step sends through such a request client still lands
in `http.jsonl`, as a `node:http` or `node:https` line, because the client
sends from the step's own process. A World subclass assigns
that page and request with `this.page = ...` and `this.request = ...`,
and a later read returns that assignment, ahead of the page `openPage()`
or `openRequest()` stored. Replace that bootstrapping
with `await this.openPage()` / `await this.openRequest()` (delegating to
the same context a mixed scenario's typed steps share, one browser and one
session per scenario), and that step's step record gains a trace and the
page's own lines in `http.jsonl`, no other code change.

## Stage 1.5: declare what you rely on

Two independent, incremental moves, safe to take alone, in either order:

- **World keys**: wrap the keys you rely on in `defineWorld({ key:
  someZodSchema })` and extend it: `class MyWorld extends defineWorld({
  seededCount: z.number() })`. That key's writes are now validated (a write
  that fails its schema fails the step and is never recorded); every other
  key keeps working, measured but unvalidated. `this` on `MyWorld` is typed
  for the declared keys too. Do not declare `page` or `request`. They are
  harness getters. A subclass can still assign them. Reach the harness
  objects with `await this.openPage()` and `await this.openRequest()`.
  `defineWorld` refuses either name at import.
  `nuka check` reports `step-file-import-failed`, and `nuka run` stops with
  the same message, which names the field.
- **Parameter types**: a support-side `defineParameterType` call still
  works, and `config.parameterTypes` is the typed-era home: moving the
  registration changes nothing about what any pattern matches, unless it
  sets `preferForRegexpMatch`. A transformer's `this` is the scenario's
  World, and a Promise it returns is awaited before the step, for a string
  pattern and a RegExp pattern alike. `preferForRegexpMatch` picks the
  type for a RegExp group that several types match, as in cucumber-js.
  `config.parameterTypes` has no such key, so a registration that sets it
  stays in support code while a RegExp step relies on it. Moved to config
  with the key, it is a config error. Moved without it, a RegExp group that
  two types match fails the step with "matches multiple parameter types"
  again.

## Stage 2: promote steps

Promote a producer before its consumer: turn the step that used to stash
data onto `this` into a `defineStep` with a `returns` schema, then have the
reader declare `from: { key: [producerStep, "resultKey"] }` for the key it
used to read off `this` (see docs/spec.md "Chaining steps"). That covers
what most existing writes to `this` turn out to be: one named value read by
one named key. When the read is not that (the value needs reshaping, which
producer to read is decided at run time, or the whole result is wanted, not
one key of it), keep the argument optional and fall back to `resultOf`,
one of `run`'s own fixtures, called as `resultOf(producerModule)`, the
same read `this` used to answer, only now against a validated result
rather than a bag. A promoted step gains a typed contract, a validated
`result`, and single-step execution via `nuka do`, none of which a compat
step has.

A `Then` is promoted to a claim step, not to a step with `run`. Its
`expect` calls become `claims`: each one reads its value through `from`
or an `observe` (not `resultOf`, which throws in a claim step), and takes
its expected value from the sentence, so a
sentence such as `the command succeeds` is reworded to state the value
(`it exits with 0`). See docs/spec.md "Claims". Until then a compat `Then`
stays a compat `Then`: a compat step cannot declare claims, and nothing
in the compat door changes what it does. Promote a `Then` after its
producer, since its claims read the producer's `returns`.

Only a claim proves a criterion (docs/spec.md "Verdicts"). A failed
assertion in a compat step, or in a step with `run`, bound in `Then`
position is `broke`, not `fail`, so a compat suite's criteria are `held`
or `failed`, never `proven`, until their `Then`s become claim steps.
Under `nuka run --base`, a new or changed one is `unproven` (red) for
the same reason, unless it is tagged `@held` and passes at the base, and
its reason says that its `Then` is a compat step, which judges no claim.
Promote the `Then` of a criterion before you change it, or tag it
`@held` when the base already has the behaviour.

## The dashboard is `nuka check`

`nuka check` is the running meter of how much migration is left:

- `then-compat-step` warns when a compat step is bound in `Then` position:
  a compat step cannot declare claims, so nukadoko cannot see what it
  judges there (see docs/spec.md "Claims"). This flags a step with no
  static signal at all in that spot, not one the tool has caught doing
  anything. Promoting it to a claim step (`defineStep` with `claims`) is
  how it gains claims to check.
- `step-file-import-failed` errors on a step file whose import threw: an
  unsupported name used as a value, a CommonJS `require`, or a deep subpath
  import (the first three gaps in "What the switch does not carry" above),
  carrying Node's own error message and the file path. The rest of the
  project is still discovered and reported alongside it: a migrating
  suite's normal state is some glue still broken, not a reason for the
  dashboard to go blank.
- `step-file-unsupported-extension` errors on a `.cjs` or `.cts` file discovery walked
  under `featuresDir` and never imported: unlike the gaps above, there is
  no import attempt behind this one to fail, so it gets its own code rather
  than reusing `step-file-import-failed`. Names the file path either way.
- `no-step-files-found` errors when the walk under `featuresDir` turned up
  nothing loadable at all, naming the directory it scanned -- the way a
  suite in an entirely unsupported shape (every glue file `.cjs`, or
  `featuresDir` pointed somewhere with none in it) is told apart from a
  suite that just has nothing to report yet.
- `unsupported-hook-tag-expression` errors on every hook whose tag
  expression goes beyond a single `@tag` / `not @tag`, not just the first
  one `nuka run` would stop at.
- `done-callback-arity` errors when a compat hook declares more parameters
  than nukadoko passes, or when a matched compat step's function declares
  more parameters than that line's captures plus a table or docstring.
  Returning `"pending"` or `"skipped"` is still a run-time failure: the
  return value is not known until the function runs.
- `undefined-step-check-suppressed` warns when an import failure above is
  holding back the `undefined-step` errors it would otherwise cause: one
  broken file's own steps going missing from the vocabulary can otherwise
  read as a pile of unrelated undefined steps. Fix the import failure
  first; the suppressed findings reappear as real `undefined-step` errors
  once the file imports cleanly.
- Step records tell the same story at run time: `world` (compat steps only) and
  `declared` shrink as more of the suite promotes to typed steps whose
  consumers read from them via `from` (or `resultOf` where a key name
  cannot say what is needed).

## The way back

The import switch is reversible, and that is a standing design rule rather
than a happy accident. Switch back to `@cucumber/cucumber` (restoring
whatever Playwright bootstrapping `openPage()`/`openRequest()` replaced),
and everything still sitting on compat is a plain cucumber-js suite again.

A step promoted to `defineStep` is a different matter, and nothing above
should be read as covering it. `defineStep` is nukadoko's own API: there is
no import to switch back. What that actually costs is worth being specific
about, because it is narrower than "locked in" suggests.

What a promoted step gives up on the way out is everything built on its
schemas: the `args`/`returns` validation, the step record's `result`, `from`
and the binding-order check that reads it, and the contract checks
`nuka check` performs.

What it keeps is the body. `run` is written against Playwright's own `Page`
and `APIRequestContext`, and nukadoko deliberately does not wrap them (see
docs/spec.md "Out of scope"), so the code doing the actual work moves as it
stands into a cucumber-js step, with the destructured `page`/`request`
fixtures replaced by whatever the World hands out. The rest is mechanical:
drop the named captures from the pattern (`{name:string}` → `{string}`),
write what `returns` returned onto `this` again, and read what `from`
declared off `this` again.

nukadoko ships no tool for that conversion, and this is stated as a limit
rather than as an argument against promoting. The import's reversibility
exists to make the first step cost one edit, not to make the typed side
optional: compat is where a suite arrives, and every reason to run it on
this tool at all (a validated `result`, a contract `nuka check` can hold a
feature against, `from`, a run summary that attests to more than "it ran")
lives on the other side of the promotion. Promote the steps whose contracts
you want, which over time should be most of the ones that matter.

## Coming from a typed-step DSL

If there are no feature files and no cucumber glue, the compat door above
does not apply. `pattern` is optional on `defineStep`: a step with no
pattern is still complete vocabulary, runnable with `nuka do` and readable
with `nuka describe`. That gives a different pair of stages from the same
rule: move each step to a typed `defineStep` first, and give it a Gherkin
`pattern` later, when a feature file makes it worth doing.

A source DSL that already carries a description, args, returns, a write
flag, and a run function translates directly: `defineStep` has a field
for each. A translated schema that JSON Schema cannot represent does not
stop `nuka describe`: it still prints that step's contract, names the
step, and exits 1.

## Working rules

These hold whichever door the suite came in through.

- **Two stages, never at once.** Change one thing, then the next. When a
  step breaks after two changes landed together, nothing tells which one
  broke it. Here the pair is "switch the import", then "add typing"; the
  other doors derive their own pair from the same rule.
- **Say where you are before the first change.** Name the stage, what it
  touches, and what it leaves alone. Switching the import is reversible
  (see [The way back](#the-way-back)); promoting a step to `defineStep` is
  not, so it gets the owner's word before the first one, not after the
  tenth.
- **The suite keeps running partway migrated.** Compat and typed steps
  share a feature file. Never make "fully typed" a precondition for
  "runs". `nuka run` refuses a scenario `nuka check` reports an error for:
  fix the finding, or pass `--no-check` while the rest catches up.
- **Delete compat glue only after its typed replacement passes.** Write
  the new step, run it with `nuka do`, then remove the old one.
- **Fix what `nuka check` and `nuka run` report, not a hunch.** Each
  finding names the file and a `fix:` or `do:` line.

Facts a migration runs into:

- `envFiles` points at the env files the suite already has (`KEY=VALUE`,
  with the rules in docs/spec.md "Environments and secrets"). A line that
  is not a blank, a comment, or a binding is `env-file-skipped-line`. A
  suite that ran once per target (a shell loop, one CI job per profile)
  becomes one run: name each target in `environments` in
  `nukadoko.program.ts` and pass `nuka run --env a --env b`.
- A `package.json` with no `"type"` loads a `.ts` file with a Node
  warning, and `nuka check` notes it as `package-type-missing`.
- `nuka run` writes no report of its own. A formatter or a JUnit-based CI
  that read cucumber messages renders them after each run with
  `nuka report --format messages --out <path>`, and `--format allure`
  does the same for Allure. A scenario tagged with a condition runs as a
  control where the condition does not hold. The messages stream leaves
  every control out, so JUnit reads a green run as green; Allure keeps
  each one, named `<scenario> (control)`, and shows one that failed as a
  failed result by design. Gate CI on `nuka run`'s exit code.
- The walk for `.feature` files skips `node_modules` and every directory
  whose name starts with `.`, at any depth, and says nothing about it.
- A glue loop that slept and tried again becomes `poll` on the fixture
  bag. Its `timeout` is a budget for the whole call (docs/spec.md
  "Context API").
- A global `After` hook that cleaned up can become a fixture's teardown.
  `nuka check` reports `fixture-structural-violation` when the fixture's
  destructuring cannot be read or names an unknown fixture.
- A promoted schema that coerces its capture (`z.coerce.number()` on a
  `{string}`) is not `capture-type-mismatch`: the run accepts it.

## Known limits

- A hook's own network traffic sits outside any step's boundary: it is
  never in any step's record.
- World measurement only sees a World's own data properties; `#private`
  fields never appear in `world.reads`/`world.writes`, by construction.
- Declared attachment file contents are not redacted: the same honest
  limit traces and screenshots already have.
- A `BeforeAll`/`AfterAll` failure is reported on stderr and in the exit
  code only. Records are written per scenario, and these hooks belong to no
  scenario, so there is nowhere yet for a run-level one to go.

The differences below do not fail: the suite runs, and a value or an order
is not what cucumber-js gives. Each one was measured by running the same
glue under cucumber-js 13.2.0 and under `nuka run`. Search the glue for
each one before you rely on the run.

- `AfterStep` hooks run in registration order. cucumber-js runs them in
  reverse registration order, the order both tools use for `After` hooks.
- A hook's `result.message` is the error message only (`boom`).
  cucumber-js gives the stack text (`Error: boom` and the frames below it).
  `result.exception` is not set.
- A step with no `{ timeout }`, in a suite that never calls
  `setDefaultTimeout`, has no time limit. cucumber-js fails it after 5
  seconds.
- `table.raw()` returns a copy. In cucumber-js, a change to a row of the
  returned array also changes what `table.hashes()` returns later.
