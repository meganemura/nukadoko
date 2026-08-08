---
name: migration
description: Use when moving an existing test suite onto nukadoko, whether from cucumber-js (typically driving Playwright) or from another DSL already shaped as typed steps. Covers the two-stage discipline that keeps every failure traceable to one change, the `nukadoko/compat` door, and promoting steps to typed `defineStep`s at your own pace.
compatibility: Requires the nuka CLI from the nukadoko npm package on PATH; every step below shells out to it (nuka init, nuka check, nuka run, nuka steps, nuka describe, nuka do).
license: MIT
---

# Migrating to nukadoko

## What this is for

An existing suite moving onto nukadoko, one piece at a time — not a rewrite.
Where it starts differs:

- **A cucumber-js suite** — feature files plus glue, usually driving
  Playwright.
- **A suite already shaped as typed steps** — its own DSL, not cucumber's,
  but close enough to nukadoko's `defineStep` that the move is mostly
  translation.

Either way, the move happens in stages, never all at once; the rest of this
skill explains why, then walks through each starting point in turn.

Everything below assumes the project is already initialized. If it isn't yet
(no `nukadoko.config.ts`), run `nuka init` first.

## Two stages, never at once

Change one thing, then the next — never both at once. If a step breaks after
two changes land together, there is no way to tell which one broke it: the
causes are tangled in a single failure. Splitting the work into stages keeps
every failure traceable to exactly one change. That is the whole point — the
stages themselves are secondary to it.

If the stages below don't fit where you're starting from, derive your own
two stages from this. What has to hold is the traceability, not these
particular stage names.

Two applications follow: a cucumber-js suite splits into "switch the import"
and "add typing" (below); a suite already shaped as typed steps splits
differently, described further down.

## Coming from a cucumber-js suite

This is the case the two stages above are named after.

### Stage 1 — make it run

Change the one import each glue file uses:

```ts
// before: import { Given, When, Then } from "@cucumber/cucumber";
import { Given, When, Then } from "nukadoko/compat";
```

Extension decides what discovery reads, not the suite's own history: `.ts`,
`.mts`, `.js`, and `.mjs` glue are all read the same way, so a suite that
was always plain JavaScript needs no rewrite to TypeScript just to start
this stage. A `.cjs` file is the one exception: nukadoko is ESM-only, so
discovery never imports one; `nuka check` names it instead
(`step-file-unsupported-extension`) rather than letting it disappear as an
unexplained `undefined-step`. Renaming it to `.js` only helps if the file's
own code is already ES module syntax; if it still calls `require(...)`,
that fails at the same import for the same ESM-only reason, and `nuka
check` says so as `step-file-import-failed`.

Then run `nuka check <feature>` and `nuka run <feature>` and read what they
say. Fix whatever they point at, and run them again. Repeat until the
existing suite is green — that is Stage 1's completion condition, nothing
more. That condition is `nuka check` and `nuka run` going green, not `tsc`
typechecking cleanly; the two can disagree in either direction.

`nuka steps` and `nuka describe` stay usable throughout Stage 1, even while
some glue files still fail to import: both read step files one at a time,
so a file still failing to import is named (`import_failures` on `--json`,
stderr otherwise) instead of emptying the whole vocabulary. Read the
vocabulary as you go rather than waiting for every file to import cleanly
first; `nuka run <feature>` and `nuka do <step>` still refuse outright on
an unreadable glue file, on purpose, since they are about to execute.

Do not go looking for a list of what compat doesn't support before you
start. Whatever will not work fails loudly, either at the import or on the
first `nuka run` — the failure names what broke, and that is what to act
on. A list written here would go stale the moment compat's coverage grows;
the CLI's own output never does.

### Stage 2 — give it contracts

Once the suite runs, some steps are worth typing. This is what changes when
one is:

| | compat step | typed step |
|---|---|---|
| Input | pattern capture only, unchecked | validated against an `args` schema, each field carrying a `.describe()` |
| Output | discarded — the receipt's `result` is `null` | validated against a `returns` schema and stored in the receipt |
| Dependencies | side effects on the World, invisible in the function signature | declared with `from`, named in an import, checked by `nuka check` before anything runs, and recorded as `used` in the receipt |
| Keyword | decorative — a step bound to `Then` can still mutate | `mutates` is a declaration nukadoko trusts: declare `mutates: true` and a read-only environment refuses to run it, and `nuka check` warns if it's bound to `Then`; what actually ran is still recorded in the receipt's `observed` counts |
| Running alone | not possible (the World is empty outside a scenario) | `nuka do <step>` runs it directly, receipt printed to stdout; a `from` key comes from `--args` like any other, or from `--use <receipt-id>` for one drawn from an earlier execution; a `resultOf` fixture call inside `run` still finds nothing, since there is no scenario for it to walk |

That last row is a separate fact from the "Dependencies" row above it, not a
consequence of it: a compat step can't run alone because what it needs lives
on a World nothing populated yet, and the World isn't part of its signature —
there's nothing to inspect to know what to set up first. A typed step's
dependencies are named as `from` entries, visible in an import, so a
`nuka do` call can supply them by hand: `--args` for an ordinary key, or
`--use <receipt-id>` for one drawn from an earlier execution's result — the
upstream step's own name never has to appear on the command line, because
the cited receipt already carries it. A step whose every key arrives that
way needs no `--args` at all: `--use` on its own is a complete invocation. What still finds nothing outside a
scenario is a dependency read through the `resultOf` fixture from inside `run`: that
call has no chain to walk when there was no scenario to build one,
`--use` or not.

Promote the steps you run most often first, one at a time — not the whole
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

### What a promoted step looks like

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
import { defineStep } from "nukadoko";
import { z } from "zod";

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

- `this.projectId` is gone; the id comes back through `returns` instead. A
  later step declares `from: { projectId: [createProjectStep, "id"] }` to
  read it by key — `nuka check` verifies the binding order before anything
  runs, and the read shows up in that later step's own receipt (the
  `resultOf` fixture stays available for the rarer read a key name can't
  express).
- The argument is a named capture bound to a schema key
  (`{name:string}` → `args.name`), so the pattern alone shows which text
  becomes which field.
- `mutates: true` is now a declaration, not just a fact about what the code
  happens to do — `nuka check` warns if this step is ever bound to `Then`,
  and a read-only environment refuses to run it at all. The receipt still
  records what the run actually sent, for review, but that count doesn't
  get the step rejected.
- `this.request` becomes the `request` fixture, named by destructuring the
  first argument: only what the executor actually injects can be named
  there, nothing implicit, and only the names actually named get built.
  A step naming neither `page` nor `context` never launches a browser.

This is the only worked example here. It's not a catalog of every gap
between compat and typed — if another pattern comes up often enough to
deserve one, that's a separate addition, not something to improvise from
this single case.

### When a global `After` hook was the cleanup

A cucumber-js suite often leans on a global `After` hook to clean up
whatever a step created, a tenant, a seeded row, a temp file. That is
worth revisiting once the step that created it is promoted: declare the
resource as a fixture under `nukadoko.config.ts`'s own `fixtures` instead,
with the cleanup written right after `await use(...)` in the same function
that built it, rather than left in a hook that has to guess, from tags
alone, which scenarios actually need it. `defineFixtures` (from the
`nukadoko` package) keeps the fixture fully typed; any typed step reaches
it the same way it reaches `page` or `request`, by destructuring the name.
This is additive, not required: an `After` hook that cleans up something
no typed step has claimed yet is still exactly as valid as it was in
Stage 1.

## Coming from a typed-step-shaped DSL

If there are no feature files and no cucumber glue, the compat door in
Stage 1 above is not relevant — skip straight past it.

What makes that possible is that `pattern` is optional on `defineStep`: a
step can be defined with no pattern at all and still be a complete piece of
CLI-only vocabulary, runnable with `nuka do` and inspectable with
`nuka describe`. That's a different pair of stages produced by the same
principle above: move each step to a typed `defineStep` first, and bundle
it into a Gherkin `pattern` later, whenever a feature file makes it worth
doing.

If the source DSL already carries something like a `description`, `args`,
`returns`, `mutates`, and a `run` function, the translation to `defineStep`
is direct — each has a `defineStep` counterpart to receive it.

## What not to do

- **Don't do Stage 1 and Stage 2 at once.** Mixing an import switch with
  added typing in the same change is exactly the thing that makes a
  failure unattributable — see "Two stages, never at once" above.
- **Don't let the suite stop running while it's partway migrated.** Compat
  and typed steps coexist in the same feature file; a suite with some
  steps promoted and others still compat must keep passing throughout.
  Never make "fully typed" a precondition for "runs."
- **Don't delete compat glue before its typed replacement is written and
  passing.** Write the new step, get it running with `nuka do`, only then
  remove the old one — never the other order.
- **Don't guess at a fix `nuka check` or `nuka run` didn't ask for.** Their
  output is the evidence for what's wrong; changing something they didn't
  flag is a change made on a hunch, not on what actually broke.
