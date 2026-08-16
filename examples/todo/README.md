# Example: a todo app, adaptive authoring, and self-healing

This is a hands-on walkthrough, not just a fixture to read: every command
below is one you can actually type. It exists to back up two specific claims
in [docs/spec.md](../../docs/spec.md) with something real instead of prose —
the agent path (`nuka do`, one step at a time, no scenario required) in
["Single steps"](../../docs/spec.md#single-steps-the-agent-path), and the
repair loop in
["Self-healing, audited"](../../docs/spec.md#self-healing-audited). A smoke
test, [`tests/examples-todo.test.ts`](../../tests/examples-todo.test.ts),
keeps this example's two checkable claims honest: the feature runs green
against the app below, and it fails the moment the app's field name changes.

## Prerequisites

- From a checkout of this repository (not needed once nukadoko is
  published): run `npm install` and `npm run build` once, from the repo
  root. This is what lets the bare `"nukadoko"` specifier
  `features/steps/*.ts` import from below actually resolve — Node resolves a
  package's own name to itself via its `exports` field (which this repo's
  `package.json` already has), but only once `dist/` exists to point at.
  Once nukadoko is published, this step disappears; a real project just
  `npm install`s it.
- Every `nuka ...` command below is shorthand for `npx tsx
  ../../src/cli.ts ...`, run from this directory (`examples/todo/`) — the
  substitution this repository needs pre-publish. After publish, it's simply
  `npx nuka ...`.

## The app

[`app/server.ts`](app/server.ts) is a deliberately minimal todo API —
`node:http` only, no framework, everything in memory:

| Method | Path | Does |
|---|---|---|
| `POST` | `/todos` | create a todo |
| `GET` | `/todos` | list every todo |
| `GET` | `/todos/:id` | one todo |
| `PATCH` | `/todos/:id` | update `done` |

Start it in its own terminal and leave it running:

```sh
npx tsx app/server.ts
```

It listens on `http://localhost:4000` by default (`--port <n>` to change
it), matching the `baseURL` already in `nukadoko.config.ts`. Run every `nuka`
command below from a second terminal, in this same directory.

There's a second mode: `--v2` (or `TODO_APP_V2=1`) renames the API's text
field from `title` to `name`, everywhere — same app, one changed field. Part
2 below uses it; ignore it for Part 1.

## Layout

- `nukadoko.config.ts` — `baseURL` only, no `envFiles` (this app needs no
  secrets).
- `features/todo.feature` — 3 scenarios: adding a todo, completing a todo,
  and adding several at once via a data table.
- `features/steps/*.ts` — 5 typed steps, each importing `defineStep` from
  `"nukadoko"` and `z` from `"zod"`, each actually calling the app above
  (nothing here is a stub):
  - `add-todo.ts` — `POST /todos` (named capture: `{title:string}`)
  - `add-todos-from-table.ts` — `POST /todos` once per row of an attached
    table
  - `complete-todo.ts` — resolves a title to an id via `GET /todos`, then
    `PATCH /todos/:id`
  - `todo-list-includes.ts` / `todo-is-marked-done.ts` — read-only
    (`mutates: false`) assertions bound in `Then` position

## Part 1 — adaptive authoring

This directory ships with its vocabulary already built. To retrace how an
agent actually arrives at that vocabulary — rather than read about it — set
one step aside and rebuild it yourself:

```sh
mv features/steps/complete-todo.ts /tmp/complete-todo.ts.bak
```

**1. Discover the vocabulary:**

```sh
nuka steps --json
```

Four steps come back, not five — `complete-todo` is the one you just moved
out of the way.

**2. Read one step's full contract:**

```sh
nuka describe add-todo
```

Prints `args`/`returns` as JSON Schema — enough for an agent to construct a
call without reading this step's source.

**3. Execute a step on its own — no scenario, no scaffolding, just the
typed contract from step 2** (this is the agent path):

```sh
nuka do add-todo --args '{"title":"Buy milk"}'
```

```json
{
  "step_record_id": "step-20260802-113336-cyfi",
  "step": "add-todo",
  "kind": "do",
  "args": { "title": "Buy milk" },
  "result": { "id": "0d8b52bf-2281-4cde-9572-a885533c03d9", "title": "Buy milk", "done": false },
  "status": "ok",
  "observed": { "http_reads": 0, "http_writes": 1 }
}
```

(`evidence`, `environment`, `session`, and the timestamps are trimmed above
for space — the real step record on your terminal has them too.) Read `result`,
decide the next call: that loop is what `nuka do` is for, and it's the same
loop whether the vocabulary is complete or, as here, missing something.

**4. `features/todo.feature` already describes completing a todo — a
`When` step the vocabulary above has no match for.** `nuka check` finds it
statically, before you'd ever hit it at `nuka run` time:

```sh
nuka check
```

```
error	undefined-step	features/todo.feature:7	No step definition matches "the todo titled "Walk the dog" is completed"; run `nuka scaffold <name>` to add one
```

**5. Scaffold it:**

```sh
nuka scaffold complete-todo
```

writes `features/steps/complete-todo.ts` as a template that compiles and
registers, but fails every time it runs, until you implement it:

```ts
import { defineStep } from "nukadoko";
import { z } from "zod";

export default defineStep({
  description: "TODO: describe complete-todo",
  args: z.object({}),
  returns: z.object({}),
  run() {
    throw new Error("not implemented: complete-todo");
  },
});
```

**6. Implement it.** There's no endpoint for "complete a todo by title", so
the step composes two calls itself — `GET /todos` to resolve the title to an
id, then `PATCH` that id's `done` to `true`:

```ts
import { defineStep } from "nukadoko";
import { z } from "zod";

// There is no "complete a todo by title" endpoint, so this step composes two
// calls itself: GET /todos to resolve the title to an id, then PATCH that
// id's `done` to true -- the same lookup-then-act shape any real client
// needs when an API only exposes operations by id.
export default defineStep({
  pattern: "the todo titled {title:string} is completed",
  description: "Find a todo by title and PATCH it to done: true",
  args: z.object({ title: z.string() }),
  returns: z.object({ id: z.string(), title: z.string(), done: z.boolean() }),
  mutates: true,
  async run({ request }, args) {
    const listRes = await request.get("/todos");
    const todos = (await listRes.json()) as Array<{ id?: string; title?: string }>;
    const match = todos.find((todo) => todo.title === args.title);
    if (!match) {
      throw new Error(`no todo titled "${args.title}" to complete`);
    }
    const res = await request.patch(`/todos/${match.id}`, { data: { done: true } });
    return res.json();
  },
});
```

(This is exactly the file this repository ships at
`features/steps/complete-todo.ts` — paste it in, or retype it; either way
you end up back at the committed version.)

**7. Check, then run:**

```sh
nuka check
```

```
ok: no issues found
```

```sh
nuka run features/todo.feature
```

Three scenario records stream to stdout, one JSON line each, every one
`"status":"passed"` — exit `0`. The vocabulary gap from step 1 is closed,
reviewably: the diff is one new step file, and this green run is its proof.

Nothing here left a lasting change (you either restored the exact file this
repo ships, or moved your backup back) — the next reader starts from the
same missing-step state you did.

## Part 2 — self-healing

Stop the app (`Ctrl-C`) and restart it as v2:

```sh
npx tsx app/server.ts --v2
```

Nothing else changed — not the feature file, not the typed steps, not their
`args`/`returns` schemas. Run the exact same scenario:

```sh
nuka run features/todo.feature
```

exit `1`. The first scenario record's first step:

```json
{
  "text": "a todo titled \"Buy milk\" is added",
  "status": "failed",
  "error": {
    "message": "returns validation failed: title: Invalid input: expected string, received undefined"
  }
}
```

The rest of that scenario's steps come back `"skipped"` — a step that never
began is not citable as evidence, so it gets no step record of its own (see
["Running"](../../docs/spec.md#scenarios-the-scripted-path)). The two
scenarios after it fail the same way, each at its own first step.

This is the app changing under the scenario, exactly as
["Self-healing, audited"](../../docs/spec.md#self-healing-audited)
describes it: the pattern still matches the Gherkin text (nothing about
matching changed), but `add-todo`'s own `returns` schema — its author's
declared contract, not a human's guess — is what caught the drift, the
moment it happened.

To re-diagnose adaptively rather than read the message and guess, an agent
has the same tool it had in Part 1 — run the one suspect step on its own:

```sh
nuka do add-todo --args '{"title":"Buy milk"}'
```

Same failure, same field, in isolation. That step record is where the trail
ends — it says *what broke*, not *why*; finding out the "why" means actually
looking at what changed, the same way a human would. Here that's one line
in `app/server.ts`: the API's text field is now called `name`, not `title`.

The fix touches every step that reads or writes a todo's title over the
wire — all 5 of them here. That is the honest cost of a field rename: small
on the wire, wide in the client, because each of these steps independently
calls the API rather than sharing one client module. It is also the point:
each affected call site now fails loudly and individually, instead of the
app quietly drifting out of sync with one part of the suite while the rest
stays green. Every step's own contract is untouched — same `args`/`returns`
schema, same feature-file prose — only the one line each uses to talk to
`/todos` changes. In `add-todo.ts`:

```diff
-    const res = await request.post("/todos", { data: { title: args.title } });
-    return res.json();
+    const res = await request.post("/todos", { data: { name: args.title } });
+    const todo = await res.json();
+    return { id: todo.id, title: todo.name, done: todo.done };
```

Mapping the wire's `name` back onto this step's own `title` key (rather than
renaming the schema itself) is what keeps the feature file and every
downstream step oblivious to the app's wire format ever having changed at
all. The other four steps need the analogous edit wherever they read a
todo's title off a `GET /todos` response (`todo.title` becomes `todo.name`).

Apply it to all 5, then:

```sh
nuka check
nuka run features/todo.feature
```

Green again — exit `0`. That green scenario run, not the `nuka do` call
above, is the proof: docs/spec.md puts it as "the proof is the repaired
scenario running green ... [the exploration step records] are the narrative, not
the proof." A PR shipping this fix cites that run; it may quote the failing
step record above as the story of how the fix was found, the same way this
walkthrough just did.

The edits above are yours to make and discard — this directory's committed
step files stay v1-shaped, so restart the app without `--v2` (or just
re-clone) and you're back to Part 1's starting point.
