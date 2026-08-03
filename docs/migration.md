# Migrating a cucumber-js + Playwright suite

For teams with an existing cucumber-js suite running against Playwright,
feature files and step definitions living under `features/` (cucumber-js's
own layout convention, and nukadoko's default too). No rewrite: the goal is
to run the suite, unchanged, on nukadoko's harness, then promote pieces at
your own pace. For a full worked example of every stage below, with real
captured command output, see
[examples/migration](https://github.com/meganemura/nukadoko/tree/main/examples/migration).

## Stage 0 — install and point nukadoko at your suite

Install nukadoko, then run `nuka init` (or hand-write `nukadoko.config.ts`)
from the project root:

```ts
import { defineConfig } from "nukadoko";

export default defineConfig({
  baseURL: "http://localhost:...", // wherever the app under test listens
  featuresDir: "features",         // point this at your existing features/
});
```

`nuka init` refuses to run if `nukadoko.config.ts` already exists, creates
`<featuresDir>/steps/`, adds `.nukadoko/` to `.gitignore`, and ends with a
self-check that discovers the (still empty) vocabulary. `featuresDir`
defaults to `features` (cucumber-js's own convention), so most suites need
no override; discovery walks the whole directory, so step files living
elsewhere under it (`features/step_definitions/`, `features/support/`) need
no reshuffling either.

## Stage 1 — switch the import

Change the one import your step files use:

```ts
// before: import { Given, When, Then } from "@cucumber/cucumber";
import { Given, When, Then } from "nukadoko/compat";
```

Everything below that import keeps working, unchanged:

- string and RegExp patterns, matched exactly as cucumber-js matches them
  (no named-capture requirement — that discipline belongs to typed steps).
- both registration shapes: `Given(pattern, fn)` and
  `Given(pattern, { timeout }, fn)`, with that timeout honored.
- a `World` (`this`); `Before`/`After` hooks written any of the three ways
  cucumber-js accepts — `Before(fn)`, `Before({ tags }, fn)`, or the
  bare-string `Before("@tag", fn)` — filtered by a single `@tag` or
  `not @tag`; custom `setWorldConstructor` subclasses. A hook receives
  cucumber's hook parameter, so `Before(function ({ pickle }) {...})` works
  as written.
- `AfterStep`, registered the same three ways as `Before`/`After`. It runs
  once per step that actually executed in the scenario, not once for the
  whole scenario the way `Before`/`After` do: a step this scenario skipped
  because an earlier one already failed never began, so `AfterStep` doesn't
  run for it either — there is no "after" for a step that never started.
- `Status`, cucumber-js's own `TestStepResultStatus` enum, re-exported under
  the same name — `result.status === Status.FAILED` inside a `Before` /
  `After` / `AfterStep` hook now imports and compares correctly.
- `DataTable` — `raw()`/`rows()`/`hashes()`/`rowsHash()`/`transpose()` — a
  step calling `table.hashes()` keeps working exactly as written (zero
  friction, measured migrating examples/migration's own suite).
- `allure.*` calls (`attach`/`log`/`link`, labels, parameters) inside
  glue — they land in the receipt's `declared` field, not vanishing.
- `setDefaultTimeout(ms)`, filling in for any step or hook that didn't
  declare its own timeout, last call winning as in cucumber-js. Never
  calling it leaves steps unbounded rather than adopting cucumber's
  5-second default: a suite shouldn't start failing for slow steps because
  it migrated.
- `BeforeAll` / `AfterAll`, bracketing the whole run, with `{ timeout }` if
  you pass one. They run only when at least one scenario was selected, take
  no `tags`, and get no World (`this`) — none exists yet when `BeforeAll`
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
`nuka run` that reaches the step — each item below says which, so the pass
is a list you can work through, not a hunt.

- **`setParallelCanAssign`, used as a value**: `nukadoko/compat` does not
  export it. An ES module's named import is resolved at link time, so
  importing it and calling it takes the whole import statement — and with
  it the file — down; split the import or drop the call. Caught before
  anything runs: `nuka check` reports the file as `step-file-import-failed`,
  carrying Node's own error message; if `check` was skipped, the same
  failure surfaces on the first `nuka run` that tries to import the file.
  This is the one name on this list that stays unsupported by decision, not
  because support just hasn't caught up yet: nukadoko has no parallel
  execution, and none is on the roadmap, so there is nothing for a
  work-assignment callback to actually control. Accepting the call as a
  no-op would be worse than refusing it — it would import cleanly, run, and
  leave a suite believing its parallel-assignment rule was in effect while
  nothing enforced it, exactly the quiet failure this door exists to refuse
  (docs/spec.md "Compat steps (the migration door)"). Failing at the import
  instead keeps that promise, the same way every other name on this list
  fails. If nukadoko ever gains parallel execution, `setParallelCanAssign`
  gets reconsidered against whatever that execution actually needs to
  control; nothing here promises when, or that it happens at all.
  (`AfterStep`, `Status`, `BeforeAll`, `AfterAll` and `setDefaultTimeout`
  were on this list when the audit ran and are now supported; see above.)
- **The same kind of name, used only as a type** is a different case, not a
  smaller version of the one above: esbuild elides a type-only import from
  the compiled output, so nothing by that name is actually imported at run
  time. Neither `nuka check` nor `nuka run` sees anything wrong, because the
  glue that ships is exactly what runs; only `tsc` complains, and that is
  `tsc`'s job, not nukadoko's. This is not a detection gap — there is
  nothing left at run time to detect. (`IWorldOptions` and
  `ITestCaseHookParameter`, the audit's own examples of this category, are
  now exported — aliases for `WorldConstructorParams`/`HookParameter` — and
  typecheck the same as any other compat name.)
- **CommonJS glue**: nukadoko is ESM-only, so `require("nukadoko/compat")`
  fails outright with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Two of the eight
  suites are CommonJS throughout. The door admits ES module glue only.
  Caught before anything runs, the same way as the value-import case above:
  `nuka check`'s `step-file-import-failed`, or the first `nuka run` if
  `check` was skipped.
- **Deep subpath imports** such as
  `import DataTable from "@cucumber/cucumber/lib/models/data_table"` have no
  equivalent here; import `DataTable` from `nukadoko/compat` instead. Caught
  the same way: `nuka check`'s `step-file-import-failed`, or the first
  `nuka run` if `check` was skipped.
- **A hook's tag expression beyond a single `@tag` / `not @tag`** (`and`,
  `or`, parentheses). `nuka check` reports every violating hook up front
  (`unsupported-hook-tag-expression`); `nuka run` enforces the same rule but
  stops at the first one it hits, since a run exits rather than lists.
- **Returning `"pending"` or `"skipped"`** from a step or hook, and
  **done-callback glue** (`function (arg, done) {...}`), each fail with a
  message naming what to write instead. Neither is visible to `nuka check`:
  both are properties of what a step does when it actually runs, not of how
  its file imports, so nothing before that step's own execution can name
  the fault — they only surface on the first `nuka run` that reaches the
  step. cucumber-js gives both of these meaning; nukadoko does not, and
  says so rather than passing the step.

Run the suite with `nuka run features/your.feature`. Every step gets a
receipt; nothing else has to change for that to start happening.

## The measured upgrade (optional)

Glue that launches its own Playwright browser or request client keeps
working, unmeasured — nukadoko never touches it. Replace that bootstrapping
with `await this.openPage()` / `await this.openRequest()` — delegating to
the same context a mixed scenario's typed steps share, one browser and one
session per scenario — and that step's receipt gains a trace, an
`http.jsonl` log, and `observed` read/write counts, no other code change.

## Stage 1.5 — declare what you rely on

Two independent, incremental moves, safe to take alone, in either order:

- **World keys**: wrap the keys you rely on in `defineWorld({ key:
  someZodSchema })` and extend it — `class MyWorld extends defineWorld({
  seededCount: z.number() })`. That key's writes are now validated (a write
  that fails its schema fails the step and is never recorded); every other
  key keeps working, measured but unvalidated. `this` on `MyWorld` is typed
  for the declared keys too.
- **Parameter types**: a support-side `defineParameterType` call still
  works, but `nuka check` warns (`parameter-type-support-origin`) and points
  at `config.parameterTypes` as the typed-era home — moving the
  registration changes nothing about what any pattern matches.

## Stage 2 — promote steps

Promote a producer before its consumer: turn the step that used to stash
data onto `this` into a `defineStep` with a `returns` schema, then have the
reader declare `from: { key: [producerStep, "resultKey"] }` for the key it
used to read off `this` (see docs/spec.md "Chaining steps"). That covers
what most existing writes to `this` turn out to be: one named value read by
one named key. When the read is not that — the value needs reshaping, which
producer to read is decided at run time, or the whole result is wanted, not
one key of it — keep the argument optional and fall back to
`ctx.resultOf(producerModule)` inside `run`, the same read `this` used to
answer, only now against a validated result rather than a bag. A promoted
step gains a typed contract, a validated `result`, and single-step
execution via `nuka do` — none of which a compat step has.

## The dashboard is `nuka check`

`nuka check` is the running meter of how much migration is left:

- `then-compat-step` warns when a compat step is bound in `Then` position —
  compat steps have no declared `mutates` for nukadoko to trust there (see
  docs/spec.md "Keyword semantics"), so this flags a step with no static
  signal at all in that spot, not one the tool has caught doing anything.
  Promoting it to `defineStep` is how it gains a declaration to check.
- `parameter-type-support-origin` warns on every support-side
  `defineParameterType`, pointing at the config move above.
- `step-file-import-failed` errors on a step file whose import threw — an
  unsupported name used as a value, a CommonJS `require`, or a deep subpath
  import (the first three gaps in "What the switch does not carry" above) —
  carrying Node's own error message and the file path. The rest of the
  project is still discovered and reported alongside it: a migrating
  suite's normal state is some glue still broken, not a reason for the
  dashboard to go blank.
- `unsupported-hook-tag-expression` errors on every hook whose tag
  expression goes beyond a single `@tag` / `not @tag`, not just the first
  one `nuka run` would stop at.
- `undefined-step-check-suppressed` warns when an import failure above is
  holding back the `undefined-step` errors it would otherwise cause — one
  broken file's own steps going missing from the vocabulary can otherwise
  read as a pile of unrelated undefined steps. Fix the import failure
  first; the suppressed findings reappear as real `undefined-step` errors
  once the file imports cleanly.
- Receipts tell the same story at run time: `world` (compat steps only) and
  `declared` shrink as more of the suite promotes to typed steps whose
  consumers read from them via `from` (or `ctx.resultOf` where a key name
  cannot say what is needed).

## The way back

The import switch is reversible, and that is a standing design rule rather
than a happy accident. Switch back to `@cucumber/cucumber` — restoring
whatever Playwright bootstrapping `openPage()`/`openRequest()` replaced —
and everything still sitting on compat is a plain cucumber-js suite again.

A step promoted to `defineStep` is a different matter, and nothing above
should be read as covering it. `defineStep` is nukadoko's own API: there is
no import to switch back. What that actually costs is worth being specific
about, because it is narrower than "locked in" suggests.

What a promoted step gives up on the way out is everything built on its
schemas: the `args`/`returns` validation, the receipt's `result`, `from`
and the binding-order check that reads it, and the contract checks
`nuka check` performs.

What it keeps is the body. `run` is written against Playwright's own `Page`
and `APIRequestContext` — nukadoko deliberately does not wrap them (see
docs/spec.md "Out of scope") — so the code doing the actual work moves as
it stands into a cucumber-js step, with `ctx.page()`/`ctx.request()`
replaced by whatever the World hands out. The rest is mechanical: drop the
named captures from the pattern (`{name:string}` → `{string}`), write what
`returns` returned onto `this` again, and read what `from` declared off
`this` again.

nukadoko ships no tool for that conversion, and this is stated as a limit
rather than as an argument against promoting. The import's reversibility
exists to make the first step cost one edit, not to make the typed side
optional: compat is where a suite arrives, and every reason to run it on
this tool at all — a validated `result`, a contract `nuka check` can hold a
feature against, `from`, a sign-off that attests to more than "it ran" —
lives on the other side of the promotion. Promote the steps whose contracts
you want, which over time should be most of the ones that matter.

## Known limits

- A hook's own network traffic sits outside any step's boundary — it is
  never counted in any step's `observed`.
- World measurement only sees a World's own data properties; `#private`
  fields never appear in `world.reads`/`world.writes`, by construction.
- Declared attachment file contents are not redacted — the same honest
  limit traces and screenshots already have.
- A `BeforeAll`/`AfterAll` failure is reported on stderr and in the exit
  code only. Records are written per scenario, and these hooks belong to no
  scenario, so there is nowhere yet for a run-level one to go.
