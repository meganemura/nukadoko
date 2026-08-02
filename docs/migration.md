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
- a `World` (`this`); `Before`/`After` hooks filtered by a single `@tag` or
  `not @tag`; custom `setWorldConstructor` subclasses.
- `DataTable` — `raw()`/`rows()`/`hashes()`/`rowsHash()`/`transpose()` — a
  step calling `table.hashes()` keeps working exactly as written (zero
  friction, measured migrating examples/migration's own suite).
- `allure.*` calls (`attach`/`log`/`link`, labels, parameters) inside
  glue — they land in the receipt's `declared` field, not vanishing.

Some things fail loudly instead of silently misbehaving: `BeforeAll`,
`AfterAll`, and `setDefaultTimeout` aren't exported by `nukadoko/compat` at
all, so importing any of them raises an immediate error naming the missing
export. A hook's tag expression beyond a single `@tag`/`not @tag` (`and`/
`or`/parentheses) fails the same way, the moment you `nuka run`.

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
