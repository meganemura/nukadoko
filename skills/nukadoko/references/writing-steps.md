# Writing a step

Finding a step, scaffolding it, running it alone, and chaining it. The
file's shape and its pattern: `step-files.md`. A Then, which claims:
`checking-steps.md`. Helpers, parts, and splitting: `parts.md`.
Fixtures, `scratch`, and `poll`: `fixtures.md`.

## Reading the vocabulary

`nuka steps --json` lists the whole vocabulary; `nuka describe <step>`
gives one step's full contract; read the JSON itself for the field
shapes. Both name any step file that failed to import beside everything
else they could still read, and `nuka check` is where to fix the import.
When a step's args or returns schema cannot be represented as JSON
Schema (a `z.date()`, say), `nuka describe` still prints that step's
contract with `args_error` or `returns_error` naming the step, and exits
1. `nuka run` and `nuka do` run the step anyway: zod still validates the
values, and only the published contract is missing.

Two fields carry less than they look like they do. A `needs` of `null`
means this tool could not read that step's `run()`, so its fixture
contract is unknown, not empty. A `needs_inferred` list is a lexical
guess at the same question: a starting inventory, never a finished one,
and never grounds for concluding a step needs no browser.

Prefer what already exists: if an acceptance condition fits an existing
step, use it, even when the criterion's wording differs from its pattern.

## When the vocabulary has no step for it

Read the `undefined-step` message first. When it ends with `patterned
steps no scanned feature line binds:`, a step that already exists lost
its line, usually through a renamed sentence or a renamed pattern. Fix
the line or the pattern instead of scaffolding a second step.

Scaffold producers before consumers. `--from <step>.<key>` reads the
producer's `returns`, and a producer that is still a stub declares none:
`nuka scaffold` refuses with `<step> declares no returns, so it has no
key to chain`. So write each Given's `returns` first, then the When that
reads from it, then the Thens that read from the When.

When the feature already holds the lines, `nuka scaffold --feature
<file>` (the `do:` line of the `undefined-step` finding, with the file
filled in) writes one stub for each line `nuka check <file>` calls
undefined, with the pattern read from the line: a quoted value is
`{value:string}`, an integer `{value:int}`, a decimal `{value:float}`, and
a Then line gets a claim step: an `observe` that throws under a TODO and a
claim on the `actual` it returns. Return the observed value, or take it
through `from` and drop `observe`. Rename `value`, `value2` to what the
values mean, in the pattern and in `args` together. A `note:` line on
stderr names each line whose reading was not the only one, or would also
match another line: that stub's pattern is the line as written, with no
capture, so put the captures in by hand. A `next:` block on stderr gives
each stub's own single scaffold with `--replace`; add `--command` or
`--from` to it, as below (`--replace` refuses a file anyone edited).

1. `nuka scaffold <name> --pattern "<feature line>"`, kebab-case, one
   file per step. Each `{key:type}` capture becomes an args field, so the
   file passes `nuka check` against that line before `run` is written. A
   type the project does not register is refused with the registered
   names listed: a number is `{key:int}` or `{key:float}`, not
   `{key:number}`. A pattern that is not a valid Cucumber Expression is
   refused too ("Writing the pattern" in `step-files.md`).
   Add `--then` for a step a Then line binds: it writes a claim step,
   `claims` in place of `run`, with no `returns` and no `mutates`. With
   one value the line states and one `--from`, the claim compares the two
   with `equal` (`view: "text"` for `stdout` or `stderr`), or the `--from`
   value with a word's literal of its type when their JSON types differ;
   otherwise it writes an `observe` stub. It refuses a line that states no
   value, and a claim across two types. A step whose feature lines carry a
   docstring or a table gets a `docstring` or `table` key, which a Then
   claims like a capture; write the feature line first, or add the key by
   hand, or `nuka check` reports `table-docstring-key-mismatch`.
   Add `--from <step>.<key>` for each value the step reads from an
   earlier step's result: it writes the import, the args field, and the
   `from` entry ("Chaining a value from an earlier step"). Repeat it with
   the same key for a key that either of two producers fills
   (`--from a.dir --from b.dir`); their schemas for the key must match.
   Add `--command <entry point>` for a When step that runs a program
   (`--command src/cli.ts`, relative to the directory `nuka` runs in, and
   refused unless a file is there): it writes `const cli = resolve("<entry
   point>")`, the `runCommand` call in an empty `scratch.dir()`, and
   `returns` of `exitCode`, `stdout`, and `stderr`. A file a Given wrote
   is in the directory that Given returned: `--from <given>.dir --cwd dir`
   runs the program there (`examples/cli.md`). Only captures are argv;
   `--argv <key>` splits one on whitespace only (`"input.csv --json"`),
   and any other `--from` value throws by name until you pass it (`env`).
   The entry point runs under plain `node`, so when `.ts` files import
   each other as `./x.js`, name the built program (`dist/cli.js`, with
   `"pretest:scenarios": "npm run build"`). Without a value the `cli` line
   holds a TODO that throws `fill in the entry point: <file>:<line>`.
   Add `--request "<METHOD> <path>"` for a When step that calls an HTTP
   API: one `request.fetch(path, { method })` on Playwright's `request`,
   against `baseURL`, returning `status` and `body` (the text). A `{key}`
   in the path is that args key's value (`"GET /items/{id}"`), `--body
   <key>` sends one as the data (`--body docstring`), and any other value
   throws by name until you pass it. Quote a path in the feature line
   (`When I request "/health"`) so `--feature` reads it as a value.
   `--command` and `--request` write `mutates: true`, because scaffold
   cannot know what the call writes; set it to `false`, with a comment
   that says why, when it writes nothing a later scenario could read.
   Add `--description "<text>"` for what the step does. Without it,
   `--command` and `--request` write a description of what they generate;
   any other form writes `TODO: describe <name>`, which `nuka check`
   notes as `step-description-todo`. Leave `--pattern` out for a step reached by name only.
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
`scratch`, or to a server a fixture started for the scenario, needs no
go-ahead (`examples/http-api.md`), nor does a claim or `mutates: false` step.

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
that. Nothing carries across `do` calls or into a scenario, login state
included, so shared state needs fixing in the feature: give it its own
step, named for what it establishes, and call it once. A scenario that
needs to be signed in gets it from a fixture or a Given step its feature names.

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
Only fall back to the `resultOf` fixture inside `run` (it throws in a claim
step) for a read `from` cannot express: the value needs reshaping on the
way, which upstream step to read is decided at run time, or the whole
result is wanted rather than one key of it.

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
