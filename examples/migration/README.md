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
all the way to typed steps wired through the `resultOf` fixture. The four stages
below walk through how a project actually gets to a state that looks like
this one, in order, each with its own real command and its own real output.

## Prerequisites

- From a checkout of this repository (not needed once nukadoko is
  published): run `npm install` and `npm run build` once, from the repo
  root -- same as [examples/todo](../todo/README.md) needs, and for the
  same reason (`dist/` is what the bare `"nukadoko"`/`"nukadoko/compat"`
  specifiers below resolve to, via Node's own
  [self-referencing package resolution](https://nodejs.org/api/packages.html#self-referencing-a-package-using-its-name)).
- **Unlike examples/todo**, every `nuka ...` command below is shorthand for
  `node ../../dist/cli.js ...`, not `npx tsx ../../src/cli.ts ...` -- run
  from this directory (`examples/migration/`). This is a compat-specific,
  pre-publish-only wrinkle, not a general nukadoko rule: this example's own
  step files bare-import `"nukadoko/compat"`, which Node's self-reference
  resolves straight to `dist/compat/index.js` regardless of how the CLI
  itself was invoked -- and `Given`/`When`/`Then`/`Before`/`defineWorld`
  registrations are ordinary module-closure state, not a `Symbol.for` brand
  like a typed `defineStep` step carries, so they do not survive being split
  across a `src` instance (if the CLI ran via `tsx src/cli.ts`) and a `dist`
  instance (what the example's own import resolved to) of the same module --
  they would silently vanish from the vocabulary discovery itself builds.
  This is exactly why examples/todo, which is typed-only, can get away with
  `tsx ../../src/cli.ts` and this example can't. Once nukadoko is actually
  installed as a real dependency in a separate project there is only ever
  one resolved copy of it, so this distinction disappears entirely; plain
  `npx nuka ...` is correct there, same as examples/todo's own note about
  publish.

## The app

Reuses [examples/todo](../todo)'s own todo API outright --
[`app/server.ts`](app/server.ts) is a thin wrapper around `createTodoApp`
from `examples/todo/app/server.ts`. This walkthrough is about glue code
evolving, not about the app underneath it; a second bespoke app would just
duplicate examples/todo's own one for nothing.

Start it in its own terminal and leave it running:

```sh
npx tsx app/server.ts
```

It listens on `http://localhost:4000`, matching the `baseURL` already in
`nukadoko.config.ts`. Run every `nuka` command below from a second
terminal, in this same directory.

## Layout

- `nukadoko.config.ts` -- `baseURL` only, borrowed from examples/todo's own.
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
- `features/steps/create-todo.ts` / `features/steps/read-created-todo-
  id.ts` -- the one promoted producer/consumer pair (Stage 2), wired
  through the `resultOf` fixture instead of a World write.

`nuka steps --json` lists the whole mixed vocabulary, typed and compat side
by side (real captured output, `description`/`mutates` only present for the
2 typed entries):

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
    "name": "read-created-todo-id",
    "kind": "typed",
    "patterns": ["the created todo id is read back via resultOf"],
    "description": "Read the previous step's validated result through resultOf",
    "mutates": false
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
import type { MigrationWorld } from "../support/world.js";

Before(async function (this: MigrationWorld) {
  await this.openRequest();
});
```

```ts
// features/steps/seed-legacy-todos.ts
import { DataTable, Given } from "nukadoko/compat";
import type { MigrationWorld } from "../support/world.js";

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
anymore, it comes from `nukadoko.config.ts` once, for every step. Every
step body below that hook -- the table read, `.hashes()`, the POSTs, the
`this.seededCount` stash, the regexp capture, the GET -- is untouched,
character for character.

Run it:

```sh
node ../../dist/cli.js run features/migration.feature
```

Real captured output, one JSON line per scenario (reformatted here for
readability; `scenario_id`/`record` ids and timestamps will differ on your
own run):

```json
{
  "scenario": "legacy glue seeds todos, stashes a note, and asserts the count",
  "status": "passed",
  "steps": [
    { "text": "a legacy note \"seed run\" is stashed", "status": "passed", "record": "step-...-2mxm" },
    { "text": "the following legacy todos are seeded:", "status": "passed", "record": "step-...-hkkk" },
    { "text": "the todo list has 2 todos", "status": "passed", "record": "step-...-i8jo" },
    { "text": "the stashed note reads \"seed run\"", "status": "passed", "record": "step-...-zpj1" }
  ],
  "hooks": [{ "type": "before", "status": "ok" }]
}
{
  "scenario": "a promoted producer feeds a typed consumer via resultOf",
  "status": "passed",
  "steps": [
    { "text": "a todo titled \"Read a book\" is created", "status": "passed", "record": "step-...-4kfn" },
    { "text": "the created todo id is read back via resultOf", "status": "passed", "record": "step-...-9x9l" }
  ],
  "hooks": [{ "type": "before", "status": "ok" }]
}
```

Green -- exit `0` -- with nothing rewritten but the import and one hook
body. `hooks: [{ "type": "before", "status": "ok" }]` on both records is
this suite's one Before hook, reported once per scenario; a hook never gets
a step record of its own (docs/spec.md "Running": it runs against the pickle's
shared World, outside any step's own boundary).

## Measured for free

Nothing above asked for measurement -- it came from switching the import.
The seeding step's own step record (`step-...-hkkk` above), real captured
output (`evidence`/`environment`/`session`/timestamps trimmed for space):

```json
{
  "record_id": "step-20260802-141751-hkkk",
  "step": "compat: the following legacy todos are seeded:",
  "kind": "run",
  "result": null,
  "status": "ok",
  "observed": { "http_reads": 0, "http_writes": 2 },
  "world": { "reads": [], "writes": ["seededCount"] }
}
```

`result: null` is honest -- this is still a compat step, with no validated
contract (docs/spec.md "Records": "Compat steps record result: null").
Everything else on this step record is new, for free, from the import switch
alone: `observed` is the 2 POSTs the harness itself watched this execution
make through `this.request`, and `world` is the one World key this step
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
`node ../../dist/cli.js run features/migration.feature`. Real captured
output from doing exactly that:

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

## Stage 2 -- promoting a producer to `resultOf`

The full promotion: a step that used to be compat glue producing data onto
`this`, and a second step reading it back off `this`, become a typed
producer and a typed consumer wired through the `resultOf` fixture --
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

and [`features/steps/read-created-todo-id.ts`](features/steps/read-created-todo-id.ts):

```ts
import createTodo from "./create-todo.js";

export default defineStep({
  pattern: "the created todo id is read back via resultOf",
  args: z.object({}),
  returns: z.object({ id: z.string() }),
  mutates: false,
  run({ resultOf }) {
    const created = resultOf(createTodo);
    if (!created) {
      throw new Error('expected a prior "a todo titled ... is created" result to read via resultOf');
    }
    return { id: created.id };
  },
});
```

Producer before consumer, deliberately -- migration-knowhow's own
recommended order: a consumer can only read a validated result once one
exists. The two step records from the same `nuka run` above (`step-...-4kfn`
and `step-...-9x9l`), trimmed the same way:

```json
{
  "record_id": "step-20260802-141751-4kfn",
  "step": "create-todo",
  "result": { "id": "41e0acba-2e60-4418-a43c-e00c0a44aa90", "title": "Read a book", "done": false },
  "status": "ok",
  "observed": { "http_reads": 0, "http_writes": 1 }
}
```

```json
{
  "record_id": "step-20260802-141751-9x9l",
  "step": "read-created-todo-id",
  "result": { "id": "41e0acba-2e60-4418-a43c-e00c0a44aa90" },
  "status": "ok",
  "observed": { "http_reads": 0, "http_writes": 0 },
  "used": [{ "record": "step-20260802-141751-4kfn", "step": "create-todo" }]
}
```

`used` is the proof: the consumer made no network call of its own
(`observed` is all zeros) and never touched a World -- there is no World
field here at all, for either step record, because a typed step's `run`
never receives `this` -- it read the producer's own validated `id`
straight through the `resultOf` fixture, and that read is recorded by the
tool, not declared by either step. This pair is this suite's fully-migrated
end state: no stash, no compat glue, no `this` at all.

## Going back

None of this is one-way. Switch the imports in `features/steps/hooks.ts`,
`seed-legacy-todos.ts`, and `legacy-todo-count.ts` back to
`"@cucumber/cucumber"` (and reintroduce your own Playwright bootstrapping
in the Before hook, the one thing `nukadoko/compat` was doing for you), and
this is a plain cucumber-js suite again -- docs/spec.md's migration door
"swings both ways."
