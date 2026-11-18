# Helpers, parts, and splitting a step

## Helper, part, or step?

Because a chained value can only come from a step, `from` pushes an
operation toward "one step, one responsibility," and that can leave a
scenario with a line that exists only to move a value from one step to the
next, never to record anything the feature's reader cares about (say, "And
the project's billing page is fetched"). A feature file is written for
someone who is not necessarily an engineer; a line like that is a cost to
that reader, not information.

Ask two questions, in order. Does the operation mean something to the
person reading the scenario, not to the code moving data between steps?

- Yes: make it a step. The run gains a step record for it, and the run
  summary a line.
- No: ask the second question.

After a failure, what should be knowable about it?

- Its inputs and its result, under a contract worth stating: make it a
  **part**. Define it as a step with no `pattern`, list it in the calling
  step's `parts`, and run it through the `call` fixture. Name `call` in that
  step's `run`, not in a fixture: `nuka check`
  reports a fixture that names it.
  Its args and its result are validated exactly as a step's are, and the
  call is recorded under `calls` on the calling step's own step record.
- Nothing a schema would help with: write an ordinary function under
  `features/steps/lib/` and call it directly. What is given up is that
  helper's own entry in the record; the HTTP it performs is still counted
  in the calling step's `observed`, and the `section` fixture can still
  mark how far execution got while running it. A function that formats a
  payload or picks a fixture file belongs here. Making it a part would
  buy a schema to maintain and nothing else.
  A helper that runs the CLI under test calls `runCommand` from
  `nukadoko` instead of `spawnSync` or `execFileSync`: it returns
  `{ exitCode, signal, stdout, stderr, files }` without throwing on a nonzero
  exit, so a step that needs the command to succeed checks `exitCode`
  itself, and each process it starts is listed in the calling step's
  `observed.processes`, so a failure record shows the command, its working
  directory, its exit code, and the files it changed. A Then that claims
  what the command wrote reads those files from the record, through a
  claim step's `files`, never from a list the step returns:
  `files: { written: { of: runBuild, change: ["added", "changed"], under: "src" } }`
  with `{ actual: "written", compare: "equal", expected: { literal: [] } }`
  for "changed no file under src/" (`has-item` a captured path, or
  `has-same-items` the docstring with `expected_view: "lines"`). The claim
  is `unjudged` when the producer ran no `runCommand`, or a walk was not
  made: a list nukadoko never measured is not an empty one. A process
  started through `spawnSync` or `execFileSync` instead is only named in
  `observed.unmeasured`, with nothing of what it printed or changed. A secret the step holds itself and passes
  as an argument goes in `redact: { NAME: value }`, so the record shows
  `{{secret.NAME}}` instead of the value.

A part is a step, not a new kind of thing. That is what makes the split
below cost the feature file nothing.

A part's `gives` and `ends` say nothing about the scenario on their own:
the line runs the composite. When a part signs someone in, put the state
in the composite's own `gives` too. A composite that names no state its
parts give or end leaves that state unknown, and `nuka check` judges no
line that requires it after this one (`states.md`).

## Splitting a step a second scenario needs half of

The original step keeps its pattern, its `args`, and its `returns`. Only
its body moves.

1. Move each half into its own step file under `features/steps/`, with no
   `pattern`. Give each one the `args` and `returns`
   it actually demands, not the ones its current caller happens to have.
2. List them in the original step's `parts`, and replace the moved code
   with a call through `call`.
3. Run `nuka check`. A part the caller did not list is refused at the
   call, and a step declaring `mutates: false` while listing a part that
   declares `mutates: true` is an error: the composite's own flag has to
   account for what it may call.
4. Run the original scenario. Its feature file did not change, so a
   reviewer who approved that sentence has nothing new to read.

`parts` takes the steps themselves (imported in TypeScript, the classes in
Ruby), never their names, the same way `from` names its producer:

```ruby
# conformance/cases/parts/steps-rb/a_done_todo.rb
class ADoneTodo < Nukadoko::Step
  pattern "a done todo titled {title:string} exists"
  description "Create a todo and complete it, through two parts"
  args { string :title, "The title of the todo" }
  returns do
    string :id, "The id of the todo"
    boolean :done, "true once completed"
  end
  mutates true
  parts [CreateTodo, CompleteById]

  def run(call:, args:)
    created = call.(CreateTodo, title: args.title)
    completed = call.(CompleteById, id: created.id)
    { id: completed.id, done: completed.done }
  end
end
```

```ts
// conformance/cases/parts/steps-ts/a-done-todo.ts
import { defineStep, z } from "nukadoko";
import createTodo from "./parts/create-todo.ts";
import completeById from "./parts/complete-by-id.ts";

export default defineStep({
  pattern: "a done todo titled {title:string} exists",
  description: "Create a todo and complete it, through two parts",
  args: z.object({ title: z.string().describe("The title of the todo") }),
  returns: z.object({
    id: z.string().describe("The id of the todo"),
    done: z.boolean().describe("true once completed"),
  }),
  mutates: true,
  parts: [createTodo, completeById],
  async run({ call }, args) {
    const created = await call(createTodo, { title: args.title });
    const completed = await call(completeById, { id: created.id });
    return { id: completed.id, done: completed.done };
  },
});
```

Get each part right on its own before wiring the composite back together.
A part with no `pattern` is still vocabulary, so it runs alone like any
other step: `nuka do create-todo --args '{"title":"x"}'`.

When the second scenario wants to name one half as a line of its own,
give that part a `pattern`. It stays callable from the composite at the
same time, so both granularities exist at once and neither scenario is
rewritten for the other.

Fixtures follow the parts: a composite whose part destructures `page` gets
a browser even though the composite itself never names `page`. That is why
`parts` is declared rather than read out of the body, and why a `call` to
a step the caller did not list is refused instead of run.

A read-only environment refuses a `mutates: true` part before it runs,
whatever the composite declared about itself. Splitting a step never moves
a mutation out of that policy's reach.

Everything measured stays on the calling step. `observed`, `sections`,
`used`, `required_env`, the evidence directory, and the trace are the
composite's, and they count the parts' work inside their totals. A part
shares its caller's `ctx`. `from` is never consulted for a call: the
caller passes every key itself.

## Generalizing a step that is too concrete

A step can sit at the right granularity for its scenario and still
hardcode a value the next scenario needs to vary. Add the `args` key,
describe it, and capture it in the pattern. `nuka check` refuses the
mismatch either way round, a required key nothing fills or a capture no
args key accepts, so the refactor is judged before anything runs.

This refactor does change the sentence in the feature file, which the
split above does not. Treat it as needing the same agreement that sentence
had in the first place: the changed line shows up in the pull request's
diff, and a person reads it again before approving. Prefer it anyway
when the hardcoded value is one the feature's reader should have been able
to see. Reach for the split instead when what varies is not a value, but
which half of the step the next scenario wants.

Nothing upstream ever runs on nukadoko's own initiative. If a step's `from`
key names a producer that never appears in the scenario, that is a `nuka
check` / `nuka run` error to fix in the feature file, never something
nukadoko inserts quietly to make the run succeed. A feature that doesn't
name everything that ran stops being the record this whole loop exists to
leave.
