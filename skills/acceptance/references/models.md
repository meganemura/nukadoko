# Exploring with a model or a relation

When one scenario is not enough to say what you want checked: an order of
operations that should never break the system, or two runs whose results
should agree. A model generates the sequences, and a relation compares
two runs. `nuka explore` runs either one and prints a scenario when it
finds a failure. The feature file stays the set of sequences a person
chose to keep.

Use this only with steps that need `request` alone. A step that needs
`page` or `context` is `explore-browser-step`, and `nuka explore` refuses
to run it.

## Writing a model

A model is the state you expect the system to be in, and one command per
step. Put the file anywhere under `featuresDir`, with a default export:

```ts
import { defineModel, modelCommand } from "nukadoko";
import addTodo from "../steps/add-todo.js";
import completeTodo from "../steps/complete-todo.js";

export default defineModel(() => ({ open: [] as string[] })).commands({
  "add-todo": modelCommand(addTodo)({
    args: (_state, draw) => ({ title: draw.pick(["milk", "eggs", "bread"]) }),
    pre: () => true,
    next: (state, args) => ({ open: [...state.open, args.title] }),
    post: (_state, args, result) => result.title === args.title && !result.done,
  }),
  "complete-todo": modelCommand(completeTodo)({
    args: (state, draw) => ({ title: draw.pick(state.open) }),
    pre: (state) => state.open.length > 0,
    next: (state, args) => ({ open: state.open.filter((title) => title !== args.title) }),
    post: (_state, args, result) => result.title === args.title && result.done,
  }),
});
```

- The key is the step's basename. `nuka check` reports
  `explore-unknown-step` when it is not.
- `args` gets the state and a `draw`. Use `draw.int(min, max)` and
  `draw.pick(items)` for every value that varies, and nothing else: no
  `Math.random`, no clock. A value the draw did not make cannot be
  replayed from the seed or shrunk.
- `pre` says when a command makes sense. A command whose `args` needs
  something from the state needs a `pre` that guarantees it.
- `next` moves the state from the args alone. It never sees the result.
  Return a new state and leave the one it was given unchanged: that same
  object is what `post` receives for this step.
- `post` judges the result against the state from before the step. Say
  what the requirement says, not what the system happens to return.
- Put the commands in the order you want a shrunk scenario to prefer:
  shrinking moves toward the first command, the first item of a `pick`,
  and the `min` of a `draw.int`.

The target is not reset between sequences. When the model's initial state
assumes an empty system, give the steps a scenario-scope fixture that
resets it (`references/fixtures.md`); each sequence opens it again.

## Writing a relation

A relation runs one declared sequence, then a second one that `follow`
builds from it, and `relate` compares the two lists of results:

```ts
import { defineRelation, relationEntry } from "nukadoko";
import addTodo from "../steps/add-todo.js";
import listIncludes from "../steps/todo-list-includes.js";

export default defineRelation({
  name: "add then listed",
  source: [relationEntry(addTodo, { title: "milk" })],
  follow: () => [relationEntry(listIncludes, { title: "milk" })],
  relate: (sourceResults, followResults) => sourceResults[0].title.length > 0 && followResults[0].found,
});
```

A relation has no seed and does not shrink. Write the source as the
smallest case that shows the relation.

## Running it

1. `nuka check`. Fix every `explore-unknown-step` and
   `explore-browser-step` finding first.
2. `nuka explore <file>`. For a model, `--runs` and `--length` set how
   much it tries. The seed is printed either way.
3. A pass prints one line on stderr and nothing on stdout.
4. A failure prints a scenario on stdout. Its first comment is the
   command that reruns the same sequences. The comment above a line says
   how that step failed. Any step failure counts, not only a `post` that
   does not hold: a fixture that fails to set up, or a target that refuses
   the connection, is shrunk and printed the same way. Read that comment
   before you decide the system is wrong. Shrinking keeps the way the run
   failed: a shorter sequence that fails another way is not printed.

## Pasting the printed scenario

The printed scenario is a draft, like `nuka harvest` output. Read it
before it goes anywhere:

1. Decide who was wrong: the system, the model, or the relation. Ask a
   person when the requirement does not say.
2. When the system was wrong, paste the scenario into the feature, name it
   with the requirement it shows, and turn the last line into the claim
   the requirement makes. Then join "The loop" at `nuka check`.
3. When the model was wrong, fix the model and say in your report which
   printed scenario showed it.
4. A comment that says a line does not read back, or that an args key has
   no capture, means pasting that line loses a value. Fix the step's
   pattern, or write that line by hand.

Never change the model or the relation only to make a failure go away. The
printed scenario is the evidence that something is wrong, and a person has
to read it first.
