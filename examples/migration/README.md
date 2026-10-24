# Example: migrating an existing suite onto nukadoko, one step at a time

This is a hands-on walkthrough, not just a fixture to read: it backs up
[docs/spec.md](../../docs/spec.md)'s
["Compat steps (the migration door)"](../../docs/spec.md#compat-steps-the-migration-door)
section with something real instead of prose -- the claim that adopting
nukadoko is a gradual door, not an all-or-nothing rewrite. A smoke test,
[`tests/examples-migration.test.ts`](../../tests/examples-migration.test.ts),
keeps this example honest: the suite below runs green end to end, and the
record shapes this walkthrough quotes as real captured output are
exactly what a fresh run of it produces.

This directory ships **already mid-migration**, on purpose -- that is the
demonstration. It is not "before" or "after"; it is the messy, realistic
middle: some glue is still cucumber-js-shaped compat code, one World key has
been promoted to a validated, declared field while another is still a plain
undeclared stash, and one producer/consumer pair has already been promoted
all the way to typed steps wired through `from`. The four stages
below walk through how a project actually gets to a state that looks like
this one, in order, each with its own real command and its own real output.

## Prerequisites

- From a checkout of this repository (not needed once nukadoko is
  published): run `npm install` and `npm run build` once, from the repo
  root -- same as [examples/todo](../todo/README.md) needs, and for the
  same reason (`dist/` is what the bare `"nukadoko"`/`"nukadoko/compat"`
  specifiers below resolve to, via Node's own
  [self-referencing package resolution](https://nodejs.org/api/packages.html#self-referencing-a-package-using-its-name)).
- Every `nuka ...` command below is `node ../../dist/cli.js ...`, run from
  this directory (`examples/migration/`). The step files bare-import
  `"nukadoko/compat"`, which Node's self-reference resolves to
  `dist/compat/index.js`, and `Given`/`When`/`Then`/`Before`/`defineWorld`
  registrations are module state, not a `Symbol.for` brand like a typed
  `defineStep` step carries: a CLI started from `src/` would read a
  different copy of that module than the one the step files filled, and the
  registrations would vanish from the vocabulary. Once nukadoko is installed
  as a real dependency in a separate project there is only one copy of it,
  and plain `npx nuka ...` is correct there.

## The app

Reuses [examples/todo](../todo)'s own todo API outright.
[`nukadoko.program.ts`](nukadoko.program.ts) serves
`../todo/app/server.ts` as it is:

```ts
export default defineProgram({
  serve: { command: "node ../todo/app/server.ts --port {port}", ready: "/todos" },
});
```

This walkthrough is about glue code evolving, not about the app underneath
it; a second bespoke app would just duplicate examples/todo's own one for
nothing. Every `nuka run` below starts the app on a free port of its own
and stops it when the run ends, so there is nothing to start by hand.

## Layout

- `nukadoko.program.ts` -- how the app starts.
- `nukadoko.config.ts` -- empty: this app needs no secrets.
- `features/migration.feature` -- 2 scenarios: one still-compat, one fully
  promoted.
- `features/support/world.ts` -- the World subclass: `defineWorld({
  seededCount: z.number() })` (Stage 1.5, one key declared and validated),
  plus `note`, a plain undeclared bag field (the stash the migration hasn't
  reached yet).
- `features/steps/hooks.ts` -- the one Before hook this suite keeps, opening
  the harness's measured request context.
- `features/steps/seed-legacy-todos.ts`, `features/steps/legacy-todo-
  count.ts`, `features/steps/legacy-note-stash.ts` -- still-compat glue: a
  table read via `.hashes()`, a `RegExp` pattern, and the World stash,
  respectively.
- `features/steps/create-todo.ts` / `features/steps/created-todo-is-
  titled.ts` -- the one promoted producer/consumer pair (Stage 2), wired
  through `from` instead of a World write. The consumer is a claim step:
  it reads the producer's result through `from` and declares what it
  claims, with no `run` and no `observe`.

`nuka steps --json` lists the whole mixed vocabulary, typed and compat side
by side (real captured output, trimmed to each entry's `name`, `kind`,
`patterns`, and, for the 2 typed entries only, `description`, `mutates`,
and the claim step's `claims`):

```json
[
  {
    "name": "create-todo",
    "kind": "typed",
    "patterns": ["a todo titled {title:string} is created"],
    "description": "Create a todo via POST /todos and return the created record",
    "mutates": true
  },
  {
    "name": "created-todo-is-titled",
    "kind": "typed",
    "patterns": ["the created todo is titled {title:string}"],
    "description": "The todo the previous step created has this title, as the app returned it",
    "mutates": false,
    "claims": [{ "actual": "createdTitle", "compare": "equal", "expected": "title" }]
  },
  {
    "name": "compat: a legacy note {string} is stashed",
    "kind": "compat",
    "patterns": ["a legacy note {string} is stashed"]
  },
  {
    "name": "compat: the stashed note reads {string}",
    "kind": "compat",
    "patterns": ["the stashed note reads {string}"]
  },
  {
    "name": "compat: /^the todo list has (\\d+) todos?$/",
    "kind": "compat",
    "patterns": ["/^the todo list has (\\d+) todos?$/"]
  },
  {
    "name": "compat: the following legacy todos are seeded:",
    "kind": "compat",
    "patterns": ["the following legacy todos are seeded:"]
  }
]
```

That is: **4 compat step definitions, 2 typed ones, 1 Before hook, 1
declared World key** -- the mixed suite the rest of this walkthrough
explains, stage by stage.

## Stage 1 -- switching an import

docs/spec.md's whole adoption pitch is that this is (almost) all it takes.
Here is a typical existing cucumber-js + Playwright suite -- hand-written
for this walkthrough, not part of this repository, but the shape is common:
its own Before hook bootstraps a Playwright request client by hand, and its
steps read/write `this` the way cucumber-js glue always has:

```ts
// before: a typical existing cucumber-js + Playwright suite
// (not part of this repository -- illustrative)
import { Before, Given, Then } from "@cucumber/cucumber";
import { request as playwrightRequest } from "playwright";

Before(async function () {
  // Every suite like this has its own version of this bootstrapping --
  // some baseURL, some disposal, hand-rolled once per project.
  this.request = await playwrightRequest.newContext({ baseURL: "http://localhost:4000" });
});

Given("the following legacy todos are seeded:", async function (table) {
  const rows = table.hashes();
  for (const row of rows) {
    await this.request.post("/todos", { data: { title: row.title } });
  }
  this.seededCount = rows.length;
});

Then(/^the todo list has (\d+) todos?$/, async function (count) {
  const res = await this.request.get("/todos");
  const todos = await res.json();
  if (todos.length !== Number(count)) {
    throw new Error(`expected ${count} todos, found ${todos.length}`);
  }
});
```

And here is what this repository actually ships --
[`features/steps/hooks.ts`](features/steps/hooks.ts) and
[`features/steps/seed-legacy-todos.ts`](features/steps/seed-legacy-todos.ts):

```ts
// features/steps/hooks.ts
import { Before } from "nukadoko/compat";
import type { MigrationWorld } from "../support/world.ts";

Before(async function (this: MigrationWorld) {
  await this.openRequest();
});
```

```ts
// features/steps/seed-legacy-todos.ts
import { DataTable, Given } from "nukadoko/compat";
import type { MigrationWorld } from "../support/world.ts";

Given("the following legacy todos are seeded:", async function (this: MigrationWorld, table: DataTable) {
  const rows = table.hashes();
  for (const row of rows) {
    await this.request.post("/todos", { data: { title: row.title } });
  }
  this.seededCount = rows.length;
});
```

([`features/steps/legacy-todo-count.ts`](features/steps/legacy-todo-count.ts)
is the `Then(/^the todo list has .../, ...)` half, same treatment.)

Two things changed, not one: the import (`@cucumber/cucumber` ->
`nukadoko/compat`), and the Before hook's own hand-rolled bootstrapping
became `await this.openRequest()` -- no `baseURL` to manage by hand there
anymore: every request resolves against the URL of the app
`nukadoko.program.ts` started, once, for every step. Every
step body below that hook -- the table read, `.hashes()`, the POSTs, the
`this.seededCount` stash, the regexp capture, the GET -- is untouched,
character for character.

Run it:

```sh
node ../../dist/cli.js run --records features/migration.feature
```

Real captured output, one JSON line per scenario, each the scenario's
entry in `run.json` (reformatted here for readability, and trimmed to
`scenario`, `status`, each step's `text`, `status`, and `step_record_id`,
and `hooks`; ids and timestamps will differ on your own run):

```json
{
  "scenario": "legacy glue seeds todos, stashes a note, and asserts the count",
  "status": "passed",
  "steps": [
    { "text": "a legacy note \"seed run\" is stashed", "status": "passed", "step_record_id": "step-...-56kd" },
    { "text": "the following legacy todos are seeded:", "status": "passed", "step_record_id": "step-...-bo9s" },
    { "text": "the todo list has 2 todos", "status": "passed", "step_record_id": "step-...-tpl6" },
    { "text": "the stashed note reads \"seed run\"", "status": "passed", "step_record_id": "step-...-glhe" }
  ],
  "hooks": [{ "type": "before", "status": "passed" }]
}
{
  "scenario": "a promoted producer feeds a typed consumer via from",
  "status": "passed",
  "steps": [
    { "text": "a todo titled \"Read a book\" is created", "status": "passed", "step_record_id": "step-...-x9fp" },
    { "text": "the created todo is titled \"Read a book\"", "status": "passed", "step_record_id": "step-...-f602" }
  ],
  "hooks": [{ "type": "before", "status": "passed" }]
}
```

Green -- exit `0` -- with nothing rewritten but the import and one hook
body. `hooks: [{ "type": "before", "status": "passed" }]` on both lines is
this suite's one Before hook, reported once per scenario; a hook never gets
a step record of its own (docs/spec.md "Running": it runs against the pickle's
shared World, outside any step's own boundary).

## Measured for free

Nothing above asked for measurement -- it came from switching the import.
The seeding step's own step record (`step-...-bo9s` above), real captured
output (`evidence`/`environment`/timestamps trimmed for space):

```json
{
  "step_record_id": "step-20261024-091719-bo9s",
  "step": "compat: the following legacy todos are seeded:",
  "kind": "run",
  "result": null,
  "status": "passed",
  "observed": { "processes": null, "http": 2, "files": null, "unmeasured": [] },
  "world": { "reads": [], "writes": ["seededCount"] }
}
```

`result: null` is honest -- this is still a compat step, with no validated
contract (docs/spec.md "Records": "Compat steps record result: null").
Everything else on this step record is new, for free, from the import switch
alone: `observed.http` counts the 2 requests the harness itself watched this
execution make through `this.request`, its `http.jsonl` holds each POST
with its request body and response body, and `world` is the one World key this step
touched, in access order -- the data flow a plain `this.foo = ...` used to
hide entirely.

## Stage 1.5 -- declaring one World key

[`features/support/world.ts`](features/support/world.ts):

```ts
const worldSchemas = {
  seededCount: z.number(),
};

export class MigrationWorld extends defineWorld(worldSchemas) {
  note: string | undefined = undefined;
}
```

`seededCount` is this suite's one promoted World key -- from here on, every
write to it is validated, not just measured; the step record above already
shows it in `world.writes`, the same way an undeclared key would. The
difference is enforcement, not visibility: as a hands-on check, temporarily
change `seed-legacy-todos.ts`'s own `this.seededCount = rows.length;` to
`this.seededCount = String(rows.length) as unknown as number;` (a
deliberately wrong type TypeScript can't catch through the cast) and rerun
`node ../../dist/cli.js run --records features/migration.feature`. The failed
step from the real output of doing exactly that, trimmed to its text,
status, and error message:

```json
{
  "text": "the following legacy todos are seeded:",
  "status": "failed",
  "error": {
    "message": "World.seededCount failed its declared defineWorld schema: (root): Invalid input: expected number, received string"
  }
}
```

exit `1`, no step record recorded for that invalid write (docs/spec.md "Compat
steps": "a write that fails its schema fails the step and is never
recorded as a write"). Revert the edit and it is Stage 1's green run again.

`note`, meanwhile, stays exactly as undeclared as it was in Stage 1 --
`features/steps/legacy-note-stash.ts` writes and reads it with a plain
`this.note = ...`, no schema, no promotion. Its own step record still shows
`"world": { "reads": [], "writes": ["note"] }` -- measured like any other
World access -- but nothing validates it, and nothing has to, yet.
Migrating a World one key at a time, not all-or-nothing, is the point of
this stage: `seededCount` and `note` sit side by side in the same class,
one declared, one not, and `nuka check`/`nuka run` are unbothered by
either.

## Stage 2 -- promoting a producer to `from`

The full promotion: a step that used to be compat glue producing data onto
`this`, and a second step reading it back off `this`, become a typed
producer and a typed consumer wired through `from` --
[`features/steps/create-todo.ts`](features/steps/create-todo.ts):

```ts
export default defineStep({
  pattern: "a todo titled {title:string} is created",
  args: z.object({ title: z.string() }),
  returns: z.object({ id: z.string(), title: z.string(), done: z.boolean() }),
  mutates: true,
  async run({ request }, args) {
    const res = await request.post("/todos", { data: { title: args.title } });
    return res.json();
  },
});
```

and [`features/steps/created-todo-is-titled.ts`](features/steps/created-todo-is-titled.ts),
a claim step: `from` fills `createdTitle` with the title the producer
returned, and the claim says it is the one the sentence names:

```ts
import createTodo from "./create-todo.ts";

export default defineStep({
  pattern: "the created todo is titled {title:string}",
  args: z.object({ title: z.string(), createdTitle: z.string() }),
  from: { createdTitle: [createTodo, "title"] },
  claims: [{ actual: "createdTitle", compare: "equal", expected: "title" }],
});
```

A claim step reads an earlier step's result only through `from`: inside
`observe`, `resultOf` throws, because a value read there would reach the
claim with no record of where it came from.

Producer before consumer, deliberately -- migration-knowhow's own
recommended order: a consumer can only read a validated result once one
exists. The two step records from the same `nuka run` above (`step-...-x9fp`
and `step-...-f602`), trimmed the same way:

```json
{
  "step_record_id": "step-20261024-091719-x9fp",
  "step": "create-todo",
  "result": { "id": "2335564f-1516-418c-8dc8-ef2dd8afc233", "title": "Read a book", "done": false },
  "status": "passed",
  "observed": { "processes": null, "http": 1, "files": null, "unmeasured": [] }
}
```

```json
{
  "step_record_id": "step-20261024-091719-f602",
  "step": "created-todo-is-titled",
  "status": "passed",
  "observed": { "processes": null, "http": null, "files": null, "unmeasured": [] },
  "used": [{ "step_record_id": "step-20261024-091719-x9fp", "step": "create-todo" }],
  "claims": [
    {
      "actual": "Read a book",
      "actual_from": "from:create-todo@19.title",
      "compare": "equal",
      "expected": "Read a book",
      "expected_from": "sentence:title",
      "expected_text": "\"Read a book\"",
      "outcome": "held",
      "measured": null
    }
  ],
  "observation": "observed",
  "attempts": 1
}
```

`used` is the proof: the consumer made no network call of its own
(its step record has no `http.jsonl`) and never touched a World. There is
no World field here at all, for either step record, because a typed step
never receives `this`. It read the producer's own validated title
through `from`, and that read is recorded by the tool, not declared by
either step. The claim record says where each side of the comparison came
from: the actual value from the title of the `create-todo` step on line
19, the expected one from the sentence. `measured` is `null` because no
recorded channel holds exactly `"Read a book"`: the producer's response
body holds it inside a larger JSON object. This pair is this suite's
fully-migrated end state: no stash, no compat glue, no `this` at all.

## Going back

None of this is one-way. Switch the imports in `features/steps/hooks.ts`,
`seed-legacy-todos.ts`, and `legacy-todo-count.ts` back to
`"@cucumber/cucumber"` (and reintroduce your own Playwright bootstrapping
in the Before hook, the one thing `nukadoko/compat` was doing for you), and
this is a plain cucumber-js suite again -- docs/spec.md's migration door
"swings both ways."
