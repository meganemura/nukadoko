# Writing a step

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
step, named for what it establishes, and call it once.

A step that declares `from` (see "Chaining a value from an earlier step"
below) still runs alone: pass the key in `--args` like any other, or add
`--use <step-record-id>` to take it from the result of an execution you
already have. The upstream step's name never goes on the command line, the
cited step record already records which step it belongs to. Repeat `--use`
for as many upstreams as the step reads.

## Return more than what a later step cites

Basing `returns` on citation alone drops the values this step's own
correctness depended on but nothing downstream reads (a computed date, a
chosen id, a resolved name), and those are exactly what a step record gets
read for once something has failed. Return them even if the scenario never
reads them back; the alternative is reconstructing what was actually sent
from another system's error message. This is also what a downstream
failure's own step record can show you: a failed step's `used` entries
carry each upstream step's full `result`, so whatever this step declined to
return is exactly what stays missing from that step record too.

## Chaining a value from an earlier step

When a step needs a value an earlier step produced, reach for `from` first:
`from: { key: [otherStep, "resultKey"] }` declares it, and the value is
filled in before the step runs (the argument stays required, and the
scenario reads as what actually chains to what). Only fall back to the
`resultOf` fixture inside `run` for a read `from` cannot express: the value
needs reshaping on the way, which upstream step to read is decided at run
time, or the whole result is wanted rather than one key of it.

A value that can arrive two ways (created in one scenario, imported in
another) lists both, and the consuming step stays one step: `from: { key:
[[stepA, "id"], [stepB, "projectId"]] }`. There is no priority between them
and no rule to memorize: exactly one of the listed producers has to be
bound earlier in that scenario, so a scenario containing both is an error
rather than a coin flip. If a scenario genuinely exercises both producers,
they are not alternatives at all: give each its own args key and let the
step read both.

Declaring `from` is not just documentation: `nuka check` reads it and
verifies the producing step actually appears earlier in the same scenario,
before anything runs. Run `nuka check <feature>` before the first `nuka
run` so a broken binding order is caught without spending a browser session
on it.

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

- Yes: make it a step. The acceptance record gains a step record for it.
- No: ask the second question.

After a failure, what should be knowable about it?

- Its inputs and its result, under a contract worth stating: make it a
  **part**. Define it with `defineStep` and no `pattern`, list it in the
  calling step's `parts`, and run it with `await call(thePart, {...})`.
  Its args and its result are validated exactly as a step's are, and the
  call is recorded under `calls` on the calling step's own step record.
- Nothing a schema would help with: write an ordinary function under
  `features/steps/lib/` and call it directly. What is given up is that
  helper's own entry in the record; the HTTP it performs is still counted
  in the calling step's `observed`, and the `section` fixture can still
  mark how far execution got while running it. A function that formats a
  payload or picks a fixture file belongs here. Making it a part would
  buy a schema to maintain and nothing else.

A part is a step, not a new kind of thing. That is what makes the split
below cost the feature file nothing.

## Splitting a step a second scenario needs half of

The original step keeps its pattern, its `args`, and its `returns`. Only
its body moves.

1. Move each half into its own file under `features/steps/`, defined with
   `defineStep`, with no `pattern`. Give each one the `args` and `returns`
   it actually demands, not the ones its current caller happens to have.
2. List them in the original step's `parts`, and replace the moved code
   with `await call(thatPart, {...})`.
3. Run `nuka check`. A part the caller did not list is refused at the
   call, and a step declaring `mutates: false` while listing a part that
   declares `mutates: true` is an error: the composite's own flag has to
   account for what it may call.
4. Run the original scenario. Its feature file did not change, so a
   sign-off over it still describes what is on disk.

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
had in the first place, and expect `nuka tend` to report a sign-off over
that feature as no longer describing what is on disk. Prefer it anyway
when the hardcoded value is one the feature's reader should have been able
to see. Reach for the split instead when what varies is not a value, but
which half of the step the next scenario wants.

Nothing upstream ever runs on nukadoko's own initiative. If a step's `from`
key names a producer that never appears in the scenario, that is a `nuka
check` / `nuka run` error to fix in the feature file, never something
nukadoko inserts quietly to make the run succeed. A feature that doesn't
name everything that ran stops being the record this whole loop exists to
leave.
