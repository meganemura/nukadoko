# Coming from a cucumber-js suite

Stage 1 switches the import and gets the existing suite green. Stage 2
types steps after that, one at a time. Do not start Stage 2 until Stage 1's
completion condition below is met (`SKILL.md`, "Two stages, never at once").

## Stage 1: make it run

Change the one import each glue file uses:

```ts
// before: import { Given, When, Then } from "@cucumber/cucumber";
import { Given, When, Then } from "nukadoko/compat";
```

Node loads glue by erasing types, so a name used only as a type needs
`type` on its import (`import { type IWorldOptions, World } from
"nukadoko/compat"`). Without it the import stays, and `nuka check` reports
`step-file-import-failed` with "does not provide an export named". An
`enum` in glue is refused the same way, at its line.

A `defineParameterType` transformer keeps cucumber-js's `this`: the
scenario World, the same object the step runs against. A Promise it
returns is awaited before the step. `docs/spec.md` states that contract.
`nuka tend` notes a registration that still lives in support code
(`parameter-type-support-origin`) and points at `config.parameterTypes`.
A registration that sets `preferForRegexpMatch` stays in support code
while a RegExp step relies on it: `config.parameterTypes` has no such key,
so moving it with the key is a config error.

`this.attach` and `this.link` follow cucumber-js: a `base64:` media type is
decoded, `{ mediaType, fileName }` names the file, a readable stream returns
a promise the step must await, and every `link` argument is a URL. The
contract is in `docs/spec.md` and `docs/migration.md`.

A World subclass can assign `this.page` and `this.request`. Glue that
launches its own Playwright and stashes the result there keeps working,
and that value stays unmeasured. `await this.openPage()` and `await
this.openRequest()` are the measured door, for when the step record
should carry the trace.

Extension decides what discovery reads, not the suite's own history: `.ts`,
`.mts`, `.js`, and `.mjs` glue are all read the same way, so a suite that
was always plain JavaScript needs no rewrite to TypeScript just to start
this stage. A `.cjs` or `.cts` file is the one exception: both are CommonJS
by extension and nukadoko is ESM-only, so discovery never imports one; `nuka check` names it instead
(`step-file-unsupported-extension`) rather than letting it disappear as an
unexplained `undefined-step`. Renaming it to `.js` only helps if the file's
own code is already ES module syntax; if it still calls `require(...)`,
that fails at the same import for the same ESM-only reason, and `nuka
check` says so as `step-file-import-failed`.

Then run `nuka check <feature>` and `nuka run <feature>` and read what they
say. Both take several files or a directory, and select the same files;
`<feature>:<line>` is a `nuka run` argument only. `nuka run` stops on any error `nuka check` reports
for the scenarios it selected; `nuka run --no-check <feature>` executes
anyway, to see how a scenario `check` refuses actually fails. Fix whatever they point at, and run them again.
Repeat until the existing suite is green: that is Stage 1's completion
condition, nothing more. That condition is `nuka check` and `nuka run` going green, not `tsc`
typechecking cleanly; the two can disagree in either direction. `nuka check
--codes` lists every finding code `check` can produce, with a one-line
description of what triggers it, so a code that shows up mid-migration and
isn't self-explanatory can be looked up without leaving the CLI. If the
suite already has env files, point `envFiles` at them (see `SKILL.md`,
"Env files"). A line the parser skips is `env-file-skipped-line`.

`envFiles` in `nukadoko.config.ts` is read at setup. A path not on disk
contributes nothing, and `nuka check` warns. A path present but unreadable,
or a directory there, is refused before any step runs: `env-file-unreadable`
and exit 2, naming the path and the errno, under `nuka check`, `nuka run`
(with or without `--no-check`), `nuka do`, and `nuka tend`.

A compat step, a hook, a BeforeAll or AfterAll, or a World constructor
that writes through `console.log` or `process.stdout.write` has that text
delivered on stderr under `nuka run`. A typed step and its fixtures do the
same under `nuka do` and `nuka run`. stdout stays the record stream
(`nuka run` writes one scenario line each only under `--records`). A child process spawned
with `stdio: "inherit"` writes to file descriptor 1 directly, so its
output still lands on stdout.

The directory walk for `.feature` files skips `node_modules` and any
directory whose name starts with `.`, at every depth, and reports nothing
about the skip. A feature a dependency ships, or a draft under
`.nukadoko`, is not part of the suite, even when `featuresDir` is the
repository root.

A migration repeats that loop far more than a finished suite ever runs
`nuka run` again. `nuka run` keeps only the newest `retention.runs` runs
(default 20) and removes older records and export files itself, so
`.nukadoko/` stays that size on its own. `nuka clean [--dry-run]` removes records and
export at once; `--dry-run` previews the same plan it would act on without
removing anything. A report `nuka report --out` wrote outside the state
directory is the suite's own file, and `nuka clean` leaves it alone.

Once more than one feature file is green, `nuka run <feature> [<feature>
...] --concurrency <n>` or `nuka run <dir> --concurrency <n>` runs the
growing suite as one invocation, spread across `n` worker processes. A file
that must not run at the same time as another, because both share one test
account or one queue, takes a `@nukadoko:serial` tag on its own `Feature:`
line.

`nuka steps` and `nuka describe` stay usable throughout Stage 1, even while
some glue files still fail to import: both read step files one at a time,
so a file still failing to import is named (a `step-file-import-failed`
finding) instead of emptying the whole vocabulary. Read the
vocabulary as you go rather than waiting for every file to import cleanly
first; `nuka run <feature>` and `nuka do <step>` still refuse outright on
an unreadable glue file, and the refusal names that file, on purpose,
since they are about to execute.
`nuka check` does not report a cited step as missing from the vocabulary
while any step file failed to import. `nuka tend` counts only the steps
that imported and leaves the unread files to `nuka check`. Fix the import
`nuka check` names (`step-file-import-failed`), then read tend again.

Glue that compat cannot load or run fails loudly, at the import, as a
`nuka check` finding, or on the first `nuka run`: the failure names what
broke, and that is what to act on. A few differences do not fail: the suite
runs, and a value or an order is not what cucumber-js gives. `docs/migration.md`
"Known limits" lists the measured ones. Read it once before you start, and
search the glue for each one. Done-callback glue is one of those findings
(`done-callback-arity`). It covers a hook past the arity the executor
passes, or a matched step whose function takes more arguments than the
line's captures plus a table or docstring. A `"pending"` or `"skipped"`
return is not in that set. It still surfaces only when the step runs.
A custom World constructor that throws is one of those run failures:
that scenario fails, stderr gets one setup line, later scenarios in the
same `nuka run` still run. A list
written here would go stale the moment compat's coverage grows; the CLI's
own output never does. One declaration is refused up front:
`defineWorld` cannot name `page` or `request`. Those are harness getters,
reached with `await this.openPage()` and `await this.openRequest()`.
`nuka check` reports `step-file-import-failed`, and `nuka run` stops with
the same message, which names the field.

## Stage 2: give it contracts

Once the suite runs, some steps are worth typing. This is what changes when
one is:

| | compat step | typed step |
|---|---|---|
| Input | pattern capture only, unchecked | validated against an `args` schema, each field carrying a `.describe()` |
| Output | discarded: the step record's `result` is `null` | validated against a `returns` schema and stored in the step record |
| Dependencies | side effects on the World, invisible in the function signature | declared with `from`, named in an import, checked by `nuka check` before anything runs, and recorded as `used` in the step record |
| Keyword | decorative: a step bound to `Then` can still mutate | `mutates` is a declaration nukadoko trusts: declare `mutates: true` and a read-only environment refuses to run it, and `nuka check` warns if it's bound to `Then`; what actually ran is still recorded in the step record's `observed` counts |
| Running alone | not possible (the World is empty outside a scenario) | `nuka do <step>` runs it directly, step record printed to stdout; a `from` key comes from `--args` like any other, or from `--use <step-record-id>` for one drawn from an earlier execution; a `resultOf` fixture call inside `run` still finds nothing, since there is no scenario for it to walk |

That last row is a separate fact from the "Dependencies" row above it, not a
consequence of it: a compat step can't run alone because what it needs lives
on a World nothing populated yet, and the World isn't part of its signature:
there's nothing to inspect to know what to set up first. A typed step's
dependencies are named as `from` entries, visible in an import, so a
`nuka do` call can supply them by hand: `--args` for an ordinary key, or
`--use <step-record-id>` for one drawn from an earlier execution's result. The
upstream step's own name never has to appear on the command line, because
the cited step record already carries it. A step whose every key arrives that
way needs no `--args` at all: `--use` on its own is a complete invocation. What still finds nothing outside a
scenario is a dependency read through the `resultOf` fixture from inside `run`: that
call has no chain to walk when there was no scenario to build one,
`--use` or not.

Promote the steps you run most often first, one at a time, not the whole
suite in one pass. How to rewrite any given piece of glue is a judgment
call for the moment you're making it; nukadoko doesn't prescribe one
recipe, and this skill won't either.

Drafting a typed step's `run` sometimes lands on the un-migrated
`run(ctx, args)` shape before it's fully destructured. `nuka steps --json`
already names which fixtures that draft touches, as `needs_inferred`: a
lexical guess read from `ctx`'s own member accesses, alongside `needs: null`
and a `needs_error` explaining why the real contract can't be read yet. It
saves rereading the whole body by hand to know what to add to the
destructured signature, but it is a guess, not the contract: it misses an
alias (`const c = ctx`) and never names `needs_browser`, so finish
destructuring rather than treating it as done.

One worked example of the rewrite is the next section. It is not a catalog
of every gap between compat and typed.

## What a promoted step looks like

One example. Before, compat glue:

```js
const { Given } = require("@cucumber/cucumber");

Given("a project {string} exists", async function (name) {
  const res = await this.request.post("/projects", { data: { name } });
  this.projectId = (await res.json()).id;
});
```

After, a typed step (`features/steps/create-project.ts`):

```ts
import { defineStep, z } from "nukadoko";

export default defineStep({
  pattern: "a project {name:string} exists",
  description: "Create a project and return its id",
  args: z.object({
    name: z.string().describe("the project's display name"),
  }),
  returns: z.object({
    id: z.string().describe("the created project's id, for later steps to cite"),
  }),
  mutates: true,
  async run({ request }, args) {
    const res = await request.post("/projects", { data: args });
    return res.json();
  },
});
```

What changed:

- `this.projectId` is gone; the id comes back through `returns` instead. Do
  not keep that value on `env` either. `env` is a frozen copy of the
  configured env files, so an assignment throws and a later step does not
  see it. A later step declares
  `from: { projectId: [createProjectStep, "id"] }` to
  read it by key: `nuka check` verifies the binding order before anything
  runs, and the read shows up in that later step's own step record (the
  `resultOf` fixture stays available for the rarer read a key name can't
  express).
- The argument is a named capture bound to a schema key
  (`{name:string}` → `args.name`), so the pattern alone shows which text
  becomes which field. `capture-type-mismatch` is a built-in capture whose JS type
  (number, string, or bigint) differs from the field's primitive type, and only
  when that field does not coerce. `z.coerce.number()` on a `{string}`
  and `z.coerce.string()` on an `{int}` are not that finding: the run
  accepts the capture. `nuka check --codes` has the one-line description.
  The same key captured twice in one pattern is refused: `nuka check`
  reports it and `nuka run` refuses the binding before the step body
  runs, and both name the key. Each capture needs its own args key.
- `mutates: true` is now a declaration, not just a fact about what the code
  happens to do: `nuka check` warns if this step is ever bound to `Then`,
  and a read-only environment refuses to run it at all. The step record still
  records what the run actually sent, for review, but that count doesn't
  get the step rejected.
- `this.request` becomes the `request` fixture, named by destructuring the
  first argument: only what the executor actually injects can be named
  there, nothing implicit, and only the names actually named get built.
  A step naming none of `page`, `context`, and `pageAs` never launches a
  browser.
  A write made with `page.request` or `context.request` (the
  APIRequestContext on the page, not the `request` fixture) is recorded on
  `observed` and http.jsonl the same way, with `via: "request"`. A GET or
  HEAD stays a read.

This is the only worked example here. It's not a catalog of every gap
between compat and typed. If another pattern comes up often enough to
deserve one, that's a separate addition, not something to improvise from
this single case.

A glue loop that slept and tried again until something appeared becomes
`poll` on the fixture bag. Its `timeout` is a budget for the whole call,
including the attempt in flight, and a non-finite or non-positive
`timeout` or `interval` is refused before that attempt starts. The
contract is in docs/spec.md ("Context API").

## When a global `After` hook was the cleanup

A cucumber-js suite often leans on a global `After` hook to clean up
whatever a step created, a tenant, a seeded row, a temp file. That is
worth revisiting once the step that created it is promoted: declare the
resource as a fixture under `nukadoko.config.ts`'s own `fixtures` instead,
with the cleanup written right after `await use(...)` in the same function
that built it, rather than left in a hook that has to guess, from tags
alone, which scenarios actually need it. If that setup exceeds the fixture
timeout, the scenario still fails, and a later `use()` resolves as
`"failed"` so the cleanup after it still runs. A failure in that cleanup
is written to stderr. That cleanup still runs if `nuka run` or `nuka do`
is stopped with SIGINT, SIGTERM, or SIGHUP. `defineFixtures` (from the
`nukadoko` package) keeps the fixture fully typed; any typed step reaches
it the same way it reaches `page` or `request`, by destructuring the name.
A fixture names setup builtins such as `page` or `request`.
It does not name `call`: that is destructured in a step's `run`, and `nuka
check` reports a fixture that does.
`nuka check` reports `fixture-structural-violation` when that fixture's
destructuring cannot be read or names an unknown fixture, and the finding
names the fixture.
This is additive, not required: an `After` hook that cleans up something
no typed step has claimed yet is still exactly as valid as it was in
Stage 1. That hook receives cucumber's hook parameter, including
`result.duration`, and `result.message` and `error` when the scenario
failed. An `AfterStep` hook receives those too, plus `pickleStep` and
`testStepId` for the step that just ran.
