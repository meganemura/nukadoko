# Writing a step

Finding a step, scaffolding it, running it alone, and chaining it. The
file's shape and its pattern: `step-files.md`. A step that checks
something: `checking-steps.md`. Helpers, parts, and splitting: `parts.md`.
Fixtures, `scratch`, and `poll`: `fixtures.md`.

## Reading the vocabulary

`nuka steps --json` lists the whole vocabulary; `nuka describe <step>`
gives one step's full contract. Read the JSON itself for the field
shapes rather than a description of them here, since a shape written
down twice is the one that goes stale. Both name any step file that
failed to import beside everything else they could still read, so a
broken file elsewhere never hides the rest of the vocabulary; `nuka check`
is where to fix the import itself. When a step's args or returns schema
cannot be represented as JSON Schema, `nuka describe` still prints that
step's contract, names the step on the failure, and exits 1. `nuka run`
and `nuka do` refuse the whole call instead, and that refusal names the
file.

Two fields carry less than they look like they do. A `needs` of `null`
means this tool could not read that step's `run()`, so its fixture
contract is unknown, not empty. A `needs_inferred` list is a lexical
guess at the same question: a starting inventory, never a finished one,
and never grounds for concluding a step needs no browser.

Prefer what already exists. If an acceptance condition can be expressed
with an existing step, use it; do not scaffold a new one just because a
criterion's wording doesn't match a pattern verbatim.

## When the vocabulary has no step for it

Read the `undefined-step` message first. When it ends with `patterned
steps no scanned feature line binds:`, a step that already exists lost
its line, usually through a renamed sentence or a renamed pattern. Fix
the line or the pattern instead of scaffolding a second step.

Scaffold producers before consumers. `--from <step>.<key>` reads the
producer's `returns`, and a producer that is still a stub returns no keys:
`nuka scaffold` refuses with `<step> does not return "<key>"; it returns
no keys`. So write each Given's `returns` first, then the When that reads
from it, then the Thens that read from the When.

When the feature already holds the lines, `nuka scaffold --feature
<file>` (the `do:` line of the `undefined-step` finding, with the file
filled in) writes one stub for each line `nuka check <file>` calls
undefined, with the pattern read from the line: a quoted value is
`{value:string}`, an integer `{value:int}`, a decimal `{value:float}`, and
a Then line gets `mutates: false`. A Then line with one value also gets
an assertion body, with `actual` left `undefined` under a TODO: read the
observed value into it. Rename `value`, `value2` to what the
values mean, in the pattern and in `args` together. A `note:` line on
stderr names each line whose reading was not the only one, or would also
match another line: that stub's pattern is the line as written, with no
capture, so put the captures in by hand. Steps that need `--command` or
`--from` are still scaffolded one at a time, as below.

1. `nuka scaffold <name> --pattern "<feature line>"`, kebab-case, one
   file per step. Each `{key:type}` capture becomes an args field, so the
   file passes `nuka check` against that line before `run` is written. A
   type the project does not register is refused with the registered
   names listed: a number is `{key:int}` or `{key:float}`, not
   `{key:number}`. A pattern that is not a valid Cucumber Expression is
   refused too ("Writing the pattern" in `step-files.md`).
   Add `--then` for a step a Then line binds: it writes `mutates: false`
   and no `returns`. With one capture, the expected value, the body asserts
   with `node:assert/strict`: `actual` is the one `--from` value (or
   `undefined` under a TODO), and the message names the expected and the
   actual value. A Then that takes a docstring or a table needs one args
   key that nothing else fills; add it by hand, or `nuka check` reports
   `table-docstring-key-mismatch`.
   Add `--from <step>.<key>` for each value the step reads from an
   earlier step's result: it writes the import, the args field, and the
   `from` entry ("Chaining a value from an earlier step"). One `--from`
   per key: a key that two producers can fill is refused, so write the
   second producer into `from` by hand.
   Add `--command <entry point>` for a When step that runs a program
   (`--command src/cli.ts`, relative to the directory `nuka` runs in, and
   refused unless a file is there): it writes `const cli = resolve("<entry
   point>")`, the `runCommand` call in its own `scratch.dir()`, and
   `returns` of `exitCode`, `stdout`, and `stderr`, so a Then step can be
   scaffolded `--from` it at once. A file a Given wrote is in another
   scratch directory, so read the Given's directory through `from` and
   pass it as `cwd` (`examples/cli.md`). The step runs the entry point
   with `node` itself, so when the project's `.ts` files import each
   other as `./x.js`, name the built program (`dist/cli.js`, with
   `"pretest:scenarios": "npm run build"`); scaffold refuses a `.ts`
   entry point whose `./x.js` import is absent beside an `x.ts`. Without
   a value the `cli` line holds a TODO, and the step throws `fill in the
   entry point: <file>:<line>` until it is filled in. `--command` leaves
   `mutates` at its default, `true`, because scaffold cannot know what the
   program writes. Declare `mutates: false`, with a comment that says why,
   when the program writes nothing outside the scratch directory.
   Add `--description "<text>"` for what the step does; without it the
   description is `TODO: describe <name>`, which `nuka tend` reports as
   `step-description-todo`. Leave `--pattern` out for a step reached by
   name only.
2. Implement it. The shape of that file is in `step-files.md`.
3. `nuka do <step> --args '<json>'`, exercise it alone, check the step
   record, before it ever touches a feature. Fix and re-run until it does
   what it's supposed to; only move on to the feature-level `nuka run` once
   every new step in the scenario has passed this way on its own. A mid-flow
   step runs as a part of a step that reaches that point; when that state
   cannot be repeated, explore it through a Playwright MCP server first
   (`references/exploring.md`).

## Asking before a step changes something

`mutates` defaults to `true`: a new step is assumed to change state unless
it says `mutates: false`, and `nuka describe <step>` shows which. Declare
what the step does, not what is convenient: a step that writes to the
application under test keeps `mutates: true`, and a step that only reads,
or only runs a program that writes nothing, says `mutates: false`.

The go-ahead depends on what the step reaches, not on the flag alone.
Before the *first* `nuka do` of a `mutates: true` step that reaches past
the project (a real service, a shared database, a file outside
`scratch`), tell the user what it is about to change and get their
go-ahead, once per step, not on every retry while fixing it, or
trial-and-error stops being possible. A step that writes only under
`scratch`, or only to a server a fixture started for the scenario, needs
no go-ahead (`examples/http-api.md`). A `mutates: false` step needs none.

With nobody to ask mid-task, because the caller handed the task over
rather than sitting in the conversation, the go-ahead has to exist before
the work starts. Either the instruction already covered these steps, and
your report says which, or it did not, and you list what you intend to
run and what each changes before starting. Running one and mentioning it
afterwards, because asking was inconvenient, is the one wrong answer.

If the same step still fails after three fix-and-retry cycles, stop and
report where it stands instead of guessing further. A prompt asking for a
different amount of patience ("try up to 10 times") overrides this
default; it is not a config setting. The same budget covers `nuka do
--use` while diagnosing a failed run (`references/diagnosing.md`).

## Running a step alone before it touches a feature

If the step body needs a local variable with the same name as a fixture,
destructure that fixture under an alias (`run({ page: pwPage, section },
args)`) instead of reusing the name: a same-named local shadows the fixture
silently rather than failing loudly.

`do` gives every call its own browser; `run` shares one page across a
scenario's steps, so a step green under `do` can still fail under `run` if
it depends on state an earlier step left (signed in, navigated elsewhere, a
dialog left open). Passing alone under `do` checks that each step works on
its own, not that it works in the scenario's own order; only `run` checks
that. `nuka do --session <name>` narrows the gap only for login state,
carrying storageState across `do` calls, not where execution had got to, so
anything else still needs fixing in the feature: give shared state its own
step, named for what it establishes, and call it once. `nuka run` takes no
session, so a scenario that needs to be signed in gets that from a fixture
or a Given step its feature names.

A step that declares `from` (see "Chaining a value from an earlier step"
below) still runs alone: pass the key in `--args` like any other, or add
`--use <step-record-id>` to take it from the result of an execution you
already have. The upstream step's name never goes on the command line, the
cited step record already records which step it belongs to. Repeat `--use`
for as many upstreams as the step reads.

## Chaining a value from an earlier step

When a step needs a value an earlier step produced, reach for `from` first:
`from: { key: [otherStep, "resultKey"] }` declares it, and the value is
filled in before the step runs (the argument stays required, and the
scenario reads as what actually chains to what). For a new step, `nuka
scaffold <name> --from other-step.resultKey` writes it: the import, the
args field typed by the producer's own schema
(`resultKey: otherStep.returns.shape.resultKey`), and the `from` entry.
Only fall back to the `resultOf` fixture inside `run` for a read `from`
cannot express: the value needs reshaping on the way, which upstream step
to read is decided at run time, or the whole result is wanted rather than
one key of it.

A value that can arrive two ways (created in one scenario, imported in
another) lists both, and the consuming step stays one step: `from: { key:
[[stepA, "id"], [stepB, "projectId"]] }`. There is no priority between them
and no rule to memorize: exactly one of the listed producers has to be
bound earlier in that scenario, so a scenario containing both is an error
rather than a coin flip. If a scenario genuinely exercises both producers,
they are not alternatives at all: give each its own args key and let the
step read both.

When the same producer runs more than once in a scenario, `from` reads
its most recent result: two registrations followed by "the confirmation
link is opened" confirm the second one (`examples/workflow.md`).

Declaring `from` is not just documentation: `nuka check` reads it and
verifies the producing step actually appears earlier in the same scenario,
before anything runs. Run `nuka check <feature>` before the first `nuka
run` so a broken binding order is caught without spending a browser session
on it.
