# Migrating a cucumber-js + Playwright suite

For teams with an existing cucumber-js suite running against Playwright,
feature files and step definitions living under `features/` (cucumber-js's
own layout convention, and nukadoko's default too). No rewrite: the goal is
to run the suite, unchanged, on nukadoko's harness, then promote pieces at
your own pace. For a full worked example of every stage below, with real
captured command output, see [examples/migration](../examples/migration/README.md).

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
loudly — at the import, or on the first `nuka run` — so the pass is a list
you can work through, not a hunt.

- **Names `nukadoko/compat` does not export**: `AfterStep`, `Status`,
  `setParallelCanAssign`, and the `IWorldOptions` /
  `ITestCaseHookParameter` types. An ES module's named import is resolved
  at link time, so a single unsupported name takes its whole import
  statement — and with it the file — down; split the import or drop the
  call. (`BeforeAll`, `AfterAll` and `setDefaultTimeout` were on this list
  when the audit ran and are now supported; see below.)
- **CommonJS glue**: nukadoko is ESM-only, so `require("nukadoko/compat")`
  fails outright with `ERR_PACKAGE_PATH_NOT_EXPORTED`. Two of the eight
  suites are CommonJS throughout. The door admits ES module glue only.
- **Deep subpath imports** such as
  `import DataTable from "@cucumber/cucumber/lib/models/data_table"` have no
  equivalent here; import `DataTable` from `nukadoko/compat` instead.
- **A hook's tag expression beyond a single `@tag` / `not @tag`** (`and`,
  `or`, parentheses) fails the moment you `nuka run`.
- **Returning `"pending"` or `"skipped"`** from a step or hook, and
  **done-callback glue** (`function (arg, done) {...}`), each fail with a
  message naming what to write instead. cucumber-js gives both of these
  meaning; nukadoko does not, and says so rather than passing the step.

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
data onto `this` into a `defineStep`, then have the reader pull that result
through `ctx.resultOf(producerModule)` instead of reading `this`. A promoted
step gains a typed contract, a validated `result`, and single-step
execution via `nuka do` — none of which a compat step has.

## The dashboard is `nuka check`

`nuka check` is the running meter of how much migration is left:

- `then-compat-step` warns when a compat step is bound in `Then` position —
  compat steps have no declared `mutates` to check statically, so this
  flags where run-time observation alone is doing the enforcement work.
- `parameter-type-support-origin` warns on every support-side
  `defineParameterType`, pointing at the config move above.
- Receipts tell the same story at run time: `world` (compat steps only) and
  `declared` shrink as more of the suite promotes to typed steps and
  `ctx.resultOf`.

## The way back

None of this is one-way. Switch the imports back to `@cucumber/cucumber`
(and restore whatever Playwright bootstrapping `openPage()`/`openRequest()`
replaced), and the suite is a plain cucumber-js suite again.

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
