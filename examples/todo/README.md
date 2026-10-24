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

Run `npm install` and `npm run build` once, from the repository root.
`npx nuka` then runs this checkout's own CLI, and the `"nukadoko"` that
`features/steps/*.ts` import resolves to this checkout through the
`exports` field of its `package.json`. Every `nuka ...` command below is
`npx nuka ...`, run from this directory (`examples/todo/`).

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
node app/server.ts
```

It listens on `http://localhost:4000` by default (`--port <n>` to change
it), matching the `baseURL` already in `nukadoko.config.ts`. Run every `nuka`
command below from a second terminal, in this same directory.

There's a second mode: `--v2` (or `TODO_APP_V2=1`) renames the API's text
field from `title` to `name`, everywhere — same app, one changed field. Part
2 below uses it; ignore it for Part 1.

## Layout

- `nukadoko.config.ts`: `baseURL`. No `envFiles` (this app needs no
  secrets).
- `features/todo.feature`: 3 scenarios: adding a todo, completing a todo,
  and adding several at once via a data table.
- `features/steps/*.ts`: 5 typed steps, each importing `defineStep` and
  `z` from `"nukadoko"`, each actually calling the app above
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
  "args_origin": { "title": "command_line" },
  "result": { "id": "0d8b52bf-2281-4cde-9572-a885533c03d9", "title": "Buy milk", "done": false },
  "status": "passed",
  "observed": { "processes": null, "http": 1, "files": null, "unmeasured": [] }
}
```

(`evidence`, `environment`, and the timestamps are trimmed above
for space; the real step record on your terminal has them too.)
`args_origin` says where each argument came from, here the command line.
`observed.http` counts the one request the step made, and the step record's
`http.jsonl` holds it with its request body and response body. Read `result`,
decide the next call: that loop is what `nuka do` is for, and it's the same
loop whether the vocabulary is complete or, as here, missing something.

**4. `features/todo.feature` already describes completing a todo — a
`When` step the vocabulary above has no match for.** `nuka check` finds it
statically, before you'd ever hit it at `nuka run` time:

```sh
nuka check
```

```text
error	undefined-step	features/todo.feature:9	No step definition matches "the todo titled "Walk the dog" is completed"
  do: nuka scaffold --feature features/todo.feature
```

**5. Scaffold it:**

```sh
nuka scaffold complete-todo --pattern "the todo titled {title:string} is completed"
```

writes `features/steps/complete-todo.ts`. `--pattern` makes the step match
the line `nuka check` reported, and its `{title:string}` becomes the
`title` field of `args`. The file compiles and registers, but fails every
time it runs, until you implement it:

```ts
import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "TODO: describe complete-todo",
  pattern: "the todo titled {title:string} is completed",
  // Give each field a .describe(): `nuka describe` shows it to whoever picks this step.
  args: z.object({
    title: z.string(),
  }),
  // Return what later steps cite and the values this step's correctness rests on;
  // beside an absence (false, 0, ""), return proof the read was valid. Declare them here:
  // returns: z.object({ ... }),
  run({}, { title }) {
    throw new Error(`not implemented: complete-todo; args ${JSON.stringify({ title })}`);
  },
});
```

**6. Implement it.** There's no endpoint for "complete a todo by title", so
the step composes two calls itself: `GET /todos` to resolve the title to an
id, then `PATCH` that id's `done` to `true`:

```ts
import { defineStep, z } from "nukadoko";

// There is no "complete a todo by title" endpoint, so this step composes two
// calls itself: GET /todos to resolve the title to an id, then PATCH that id's
// `done` to true. The same lookup-then-act shape any real client needs when an
// API only exposes operations by id. A step taking the id instead would push
// the lookup into the feature file, where a reader has no id to write.
export default defineStep({
  pattern: "the todo titled {title:string} is completed",
  description: "Find a todo by title and PATCH it to done: true",
  args: z.object({ title: z.string().describe("The title of the todo to complete; must already exist") }),
  returns: z.object({
    id: z.string().describe("The id of the todo that was completed"),
    title: z.string().describe("Its title, as the server returned it"),
    done: z.boolean().describe("true after the PATCH"),
  }),
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
`features/steps/complete-todo.ts`. Paste it in, or retype it; either way
you end up back at the committed version.)

**7. Check, then run.**

```sh
nuka check
```

```
ok: no issues found
```

```sh
nuka run --records features/todo.feature
```

Three scenarios stream to stdout (`--records` asks for them), one
JSON line each, the same entries `run.json` holds, every one `"status":"passed"`, and the exit code is `0`. The vocabulary gap from step 1 is closed,
reviewably: the diff is one new step file, and this green run is its proof.

Nothing here left a lasting change: you either restored the exact file this
repository ships, or moved your backup back. The next reader starts from
the same committed state you did.

## Part 2 — self-healing

Stop the app (`Ctrl-C`) and restart it as v2:

```sh
node app/server.ts --v2
```

Nothing else changed — not the feature file, not the typed steps, not their
`args`/`returns` schemas. Run the exact same scenario:

```sh
nuka run --records features/todo.feature
```

exit `1`. The first scenario's first step, as its stdout line and
`run.json` carry it (the record id differs from run to run):

```json
{
  "line": 4,
  "text": "a todo titled \"Buy milk\" is added",
  "step": "add-todo",
  "status": "failed",
  "step_record_id": "step-...",
  "record": "steps/step-...",
  "error": {
    "kind": "result_invalid",
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

## Part 3 — review

Parts 1 and 2 end at a green run. The claim this tool exists for is one
step further: that a scenario was green at a named commit, in a form a
reviewer can read without the state directory. Every `nuka run` already
writes that form, the run summary:

```sh
nuka run features/todo.feature   # every scenario green
```

The `summary` line `nuka run` prints on stderr names the file, under
`.nukadoko/runs/<run_id>/summary.md`. It holds the
run's verdict and scenario counts; the condition (the commit, whether the
tree had uncommitted changes, the environment, the browsers, and the
times); and one table per feature, with a row per scenario. Every step here goes
through `request`, never `page`, so the browsers line reads "none
launched". The summary is built only from what the run measured, so the
`.nukadoko/` records stay out of git and the summary is what a person
keeps.

In CI, `nuka report --format markdown --out <path>` writes a copy of the
newest run's summary that a workflow step posts
on the pull request, and under GitHub Actions the job's own summary page
shows it with no configuration (`docs/ci.md` has the workflow). A reviewer
who writes no code then reads two things in the PR: the `.feature` in the
diff, to check it says what the ticket meant, and the run summary beside
it, the evidence of what ran at that commit. nukadoko records that
evidence and not the approval: where the reviewer's approval is recorded
is the team's process, and nukadoko writes or commits nothing else for it.

To tie a feature to a ticket, write the ticket in the feature itself; there
is no separate field, on purpose. A tag or a description line above the
first scenario is enough:

```gherkin
@ticket:ACME-123
Feature: Todo list
  Acceptance criteria for ACME-123 (add, complete, bulk add).
```

The tag reaches the Allure report as a label, and the feature text is in
the pull request's diff, so the ticket travels with both. `ACME-123` here
is a placeholder, not a real ticket.
