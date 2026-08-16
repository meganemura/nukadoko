---
name: acceptance
description: Use when turning a requirement into a signed-off Gherkin scenario, starting from whatever is on hand, whether that is raw prose with no stated acceptance criteria yet (a ticket, a request, a conversation), acceptance criteria that still need concrete scenarios, or a scenario ready to write, run, and sign off.
compatibility: Requires the nuka CLI from the nukadoko npm package on PATH; the loop below shells out to it (nuka init, nuka steps, nuka describe, nuka scaffold, nuka do, nuka check, nuka run, nuka accept, nuka tend).
license: MIT
---

# nukadoko acceptance loop

## What this is for

A sign-off records that a scenario ran green at one commit: write the
scenario once, run it until green, and sign it off. Signing off and
running the scenario in CI answer different questions, sign-off for that
one commit, CI for whether the criteria still hold today, and nukadoko
never re-runs a signed scenario on its own.

Right after signing off, decide which of the two this scenario is for
from here on. A ticket's acceptance criteria are usually about the change
itself, and once that change has landed there is nothing left for a
re-run to confirm, so the feature stays where it is. Some scenarios
describe a path through the product that stays true long after the
ticket closes; running those on every future commit is worth doing, so
the feature moves into `featuresDir` instead (see "What not to do").

This skill covers the whole path from whatever you start with (raw prose,
general acceptance criteria, or a scenario ready to write) through to that
sign-off and the placement decision right after it. "Where to start" below
picks the entry point for what you have.

## Where to start

Every path below funnels into the same loop, the same `nuka accept`, and
the same placement judgment right after it (see "What not to do"). What
differs is only where you enter:

1. **All you have is prose** (a ticket, a request, a conversation), nothing
   that reads as a testable statement yet: start at "From prose to
   requirements" below.
2. **You already have general acceptance-criteria sentences** (a ticket's
   bullet list, a "the system shall..." statement) but no scenario yet:
   start at "From requirements to scenarios" below.
3. **You already have, or can write directly, a concrete scenario**: skip
   ahead to "The loop" below.

If none of the three is true either, there is nothing yet to interrogate:
ask the user what this is supposed to do before writing anything, since a
scenario started without knowing what it proves just proves the wrong
thing.

Everything below assumes the project is already initialized. If it isn't
yet (no `nukadoko.config.ts`), run `nuka init` first.

## From prose to requirements

Nothing in this stage runs a `nuka` command; a ticket, a request, or a
conversation isn't vocabulary yet, so there is nothing here for the CLI to
check. What this stage produces is text: a set of requirement statements,
each either complete or carrying a named question for the person who can
answer it.

Read the prose against the five EARS patterns as a checklist for what a
requirement needs to say to be actionable, not as a template to generate
polished-sounding wording from. A pattern's slots come from the prose
itself; a slot the prose doesn't state is a question, never a guess:

- **Ubiquitous**: "The `<system>` shall `<response>`." Always true, no
  trigger and no condition.
- **Event-driven**: "When `<trigger>`, the `<system>` shall `<response>`."
- **State-driven**: "While `<state>`, the `<system>` shall `<response>`."
- **Unwanted behaviour**: "If `<trigger or condition>`, then the
  `<system>` shall `<response>`."
- **Optional feature**: "Where `<feature is present>`, the `<system>`
  shall `<response>`."

For each requirement-shaped statement in the prose:

1. Decide which pattern fits, or notice the sentence is actually several
   requirements compounded into one and split it first: a sentence with
   "and" joining two different responses, or an implicit "unless," is
   usually more than one requirement wearing one sentence.
2. Fill each slot only with words the prose actually supports.
3. Anything a slot needs that the prose doesn't state stays open: write it
   as a question addressed to whoever can answer it, and leave the slot
   unfilled rather than choosing a plausible value to move forward.
4. Keep each requirement's own open questions attached to that
   requirement, never pooled into one list, so a reader can see which
   sentence is still unanswered rather than which set is.

For example, a ticket that says "the export should fail gracefully if the
file is too large" reads as an unwanted-behaviour candidate: "If `<file too
large>`, then the system shall `<fail gracefully>`." Both slots are
actually open. "Too large" names no threshold: what size, or what resource
limit, triggers it? "Fail gracefully" names no response: does the user see
a message, is the upload retried, is partial output cleaned up? Neither
gets a value invented to fill the pattern; both become questions back to
whoever wrote the ticket.

Once a requirement's slots are all filled from stated fact, and every open
slot has been resolved into an answered question, it is ready for the next
stage, "From requirements to scenarios" below. A model drafting this
classification is fine; the discipline lives in refusing to fill a slot the
source didn't support, not in refusing to draft at all.

## From requirements to scenarios

This is where information gets added that no requirement sentence stated:
concrete values, boundaries, negative paths. Turning "a discount code
applies to eligible orders" into a scenario means picking an actual code,
an actual order total, and an actual eligibility rule to test against, and
none of those came from the requirement itself. This is real information,
not implied by the requirement, so it has to be visible, not silently
assumed.

- **Surface every assumption.** State beside the scenario what was chosen
  and why (a comment, a linked table, or the PR description), rather than
  leaving a literal value to speak for itself. A reviewer who can't see
  what was assumed can't tell whether it was the right assumption.
- **Keep the trace.** Which requirement sentence produced which scenario
  should be readable later, not just at the moment of writing. The
  ticket-verbatim convention under `Feature:` (see "Writing the feature"
  below) already carries this for a scenario sourced from a ticket; keep
  the same discipline for one sourced from the requirements stage above.
- **Know when a single scenario stops being the right tool.** A rule with
  several combining conditions doesn't resolve sentence by sentence; reach
  for a decision table or a state model instead of writing one scenario
  per case and hoping the combinations stay covered. What decides whether
  to reach for one is the number of conditions the rule combines, not how
  large the project is: a two-person tool with one four-condition rule
  needs the table as much as a large one does.

A model drafting this translation is not the problem this stage guards
against; drafting is fine, and it can happen before any of it is fixed.
What gets fixed is the moment a person reads the draft, sees the
assumptions it made, and accepts them: that happens before any
implementation is generated from the scenario, which is the whole point of
doing it here rather than after. What the stage forbids is a draft whose
assumptions never surface at all, not the act of drafting one.

## The loop

1. Read the vocabulary: `nuka steps --json`, then `nuka describe <step>`
   for the contract of anything that looks relevant.
2. When an operation is missing, `nuka scaffold <name>`, implement it, and
   exercise it alone with `nuka do` until its step record looks right.
3. Write the feature. A tag and the description under `Feature:` carry the
   ticket id and the criteria in the reviewer's words; the scenarios are
   those criteria translated into the vocabulary.
4. `nuka check <feature>`: every static inconsistency it can catch, before
   anything runs (see "Running and accepting").
5. Commit. A run can only be frozen if it happened on a clean tree at the
   commit still checked out, so debugging runs against a dirty tree are
   fine; they simply cannot be accepted.
6. `nuka run <feature>` until green; when it fails, diagnose from the
   failed step's own step record before repeating the whole run (see "When
   a run fails").
7. `nuka accept <feature>`, then commit the record it wrote.

## Reading the vocabulary

- `nuka steps --json` lists the whole vocabulary; `nuka describe <step>`
  gives one step's full contract. Read the JSON itself for the field
  shapes rather than a description of them here, since a shape written
  down twice is the one that goes stale. Both name any step file that
  failed to import beside everything else they could still read, so a
  broken file elsewhere never hides the rest of the vocabulary; `nuka check`
  is where to fix the import itself.
- Two fields carry less than they look like they do. A `needs` of `null`
  means this tool could not read that step's `run()`, so its fixture
  contract is unknown, not empty. A `needs_inferred` list is a lexical
  guess at the same question: a starting inventory, never a finished one,
  and never grounds for concluding a step needs no browser.
- Prefer what already exists. If an acceptance condition can be expressed
  with an existing step, use it; do not scaffold a new one just because a
  criterion's wording doesn't match a pattern verbatim.

## When an operation is missing

1. `nuka scaffold <name>`, kebab-case, one file per step.
2. Implement it.
3. `nuka do <step> --args '<json>'`, exercise it alone, check the step
   record, before it ever touches a feature. Fix and re-run until it does
   what it's supposed to; only move on to the feature-level `nuka run` once
   every new step in the scenario has passed this way on its own.

`mutates` defaults to `true`, a new step is assumed to change state unless
it says `mutates: false`, and `nuka describe <step>` tells you which before
you ever run it, so there's no need to guess. Before the *first* run of a
step whose contract says `mutates: true`, tell the user what it's about to
change and get their go-ahead, once per step, not on every retry while
fixing it, or trial-and-error stops being possible. Steps with `mutates:
false` are observation only (the Then side); they don't need this.

If the same step still fails after three fix-and-retry cycles, stop and
report where it stands instead of continuing to guess. A prompt asking for
a different amount of patience ("try up to 10 times", "don't ask, just keep
going") overrides this default; it isn't something to change in a config
file. The same budget applies to `nuka do --use` while diagnosing a failed
run (see "When a run fails").

Give every `args` and `returns` field a zod `.describe()`. That's what lets
`nuka describe` connect an acceptance criterion's own wording to a schema
field, so anyone reading the contract later can tell which field answers
which condition. This matters most on the Then side (`mutates: false`): a
step verifying "an error is shown" needs its `returns` field for that
message described, or the link between the criterion and what was actually
observed is lost.

Aliasing a fixture, the `do`/`run` gap, and what a step should return
beyond what a later step cites: `references/writing-steps.md`.

## Chaining a value from an earlier step

Reach for `from: { key: [otherStep, "resultKey"] }` when a step needs a
value an earlier step produced: the value is filled in before the step
runs, and `nuka check` verifies the producing step actually appears earlier
in the same scenario, before anything runs.

The `resultOf` fixture fallback, a value with two possible producers, and
why a chained value is never fetched by nukadoko on its own initiative:
`references/writing-steps.md`.

## Helper or step?

Judge each operation on one axis: does it mean something to the person
reading the scenario, not to the code moving data between steps? Yes, make
it a step, and the acceptance record gains a step record for it. No, write
an ordinary function under `features/steps/lib/` instead and call it from
the step that needs the value: the HTTP it performs is still counted in
the calling step's `observed`.

The full reasoning, and the kind of line this keeps out of a feature file:
`references/writing-steps.md`.

## A resource that needs its own cleanup

When a scenario needs a project resource a step merely borrows (a tenant, a
seeded database row, an uploaded file), don't write its teardown inside the
step: that puts something in the feature file that is not itself an
acceptance condition. Declare it as a fixture instead, under
`nukadoko.config.ts`'s own `fixtures`, using `defineFixtures` (from the
`nukadoko` package). A step reaches it the same way it reaches `page` or
`request`, by destructuring the name; setup runs the first time a step
names it, and teardown runs after that step's scenario finishes, whether
the scenario passed or failed.

A step that writes to a system whose effect lands elsewhere asynchronously
isn't finished when the write is accepted, it's finished once that effect
is visible to whatever runs next: wait for it there, with the `poll`
fixture, not in a later step that merely reads the effect.

The fixture example, build order and scope options, and the full `poll`
discussion (including what a wait function should and shouldn't wait for):
`references/fixtures.md`.

## Adding your own evidence

The automatic evidence (screenshot, trace, `http.jsonl`, `page_events`)
never covers something application-specific: an API response body, a DB
row, a generated file's contents. Reach for the `evidence` fixture for
that, `evidence.attach(name, body)`, rather than logging it away or
writing it to disk with no place on the step record to point back at.

Attachment shapes, `evidence.path()`, and the secrets rule:
`references/evidence.md`.

## Writing the feature

Everything you were able to learn about the ticket goes into the feature
file: nukadoko has no concept of a ticket, so the feature is the only
place that link is recorded, and accepting it freezes the whole file into
the record read back months later. Carry across the ticket's id, URL,
title, and acceptance criteria in the reviewer's own words, unparaphrased,
under a tag and free text below `Feature:`. Don't write a field you
couldn't fill: an empty `Ticket:` line is worse than no line at all, it
reads as a link that was lost rather than one that was never available.

Each scenario is that same criteria translated into the vocabulary from
"Reading the vocabulary" above, whether it arrived there straight from a
ticket or through the requirements and scenario stages earlier in this
skill. Where the translation is a judgment call, that judgment is what PR
review of the feature is for.

The tag shape and a worked example: `references/writing-the-feature.md`.

## Running and accepting

`nuka check <feature>` catches every static inconsistency before anything
executes, including a broken `from` binding order; run it before the first
`nuka run` (see "The loop" above). All of the trial and error, `nuka do`
while building a step, `nuka run` while getting the feature green, happens
against a verification environment: never pass a production-pointing name
to `--env`. An environment configured with `policy: "read-only"` is a
second backstop, not a substitute for picking the right one; the engine
refuses any mutating step there outright regardless of what `--env` was
given.

`nuka accept <feature>` freezes the newest all-green run of that feature,
restricted to runs matching the current environment and `browserType`,
both matched against what each candidate run actually measured, never a
declaration. On success, stderr also asks the placement question (see
"What not to do"); stdout stays exactly the record's own path.

Condition matching, stderr/stdout shapes during `nuka run`, and the
`<feature>:<line>` narrowing option: `references/running.md`.

## When a run fails

Before repeating `nuka run <feature>`, work through the failed step's own
step record in this order:

1. Its `used` entries: each carries the full validated `result` of the
   upstream step it read from, sitting right on the step record that
   failed.
2. `actions`: every Playwright call this step made through the `page`
   fixture (`expect` waits included), each with its own duration and
   outcome, read straight off the step's own trace.
3. `page_events`, if the step opened a browser: a console error, an
   uncaught page error, or a failed request recorded there can explain a
   failure nothing else on the step record mentions.
4. `nuka do <step> --use <upstream-step-record-id>` to test a hypothesis
   directly: seconds, where a full `nuka run` costs minutes, and it still
   counts toward the same three-fix-and-retry-cycles rule as any other fix.
5. Re-run the whole feature last, once the step itself passes under `do`,
   not as the first thing tried after a failure.

Reading the step record as one ordered timeline, the `final.png` gotcha,
and when to reach for the trace viewer: `references/diagnosing.md`.

## When accept refuses

`accept` always says which refusal condition fired, in stderr, along with
the next command to run. Read that message and act on it; stderr is the
source of truth here. One shape worth knowing ahead of time: "no run to
freeze" can mean a green full run of the feature exists, just not under
the current condition; that refusal names the condition it looked for and
lists every condition that does have a run.

The full refusal message shape: `references/diagnosing.md`.

## Keeping records honest over time

A record freezes the feature source and every step record from the run it
accepted, but not the contracts behind them: change a step's `returns`
after accepting, edit the feature, or delete a step it cites, and the
record still sits there claiming a green run it can no longer support.
Nothing about that stops a future run, so `nuka check` never mentions it.
`nuka tend` is what finds it (a stale record is the only finding that
exits non-zero); run it periodically, not in this loop, since it answers
whether the vocabulary and its records are healthy, not whether this run
can proceed. When it reports a stale record, the fix is to run the feature
again and `nuka accept` it again, or to undo the change that invalidated
it, never by editing the record.

What `nuka tend` reports, and stops reporting, once a feature moves into
`featuresDir`: `references/maintenance.md`.

## What not to do

- **Decide where the feature belongs, right after signing off** (`nuka
  accept`'s own stderr asks the same question as a reminder). A feature
  describing the change stays outside `featuresDir`: name its directory
  in `additionalFeatureDirs` in `nukadoko.config.ts` so `nuka check` and
  `nuka tend` still see the steps it binds, instead of reporting them
  unbound, without it ever running unattended. If you can't touch the
  config, pass the feature path to `nuka check` instead (see "Running and
  accepting"). A feature describing the product's own core path moves into
  `featuresDir` instead, so `nuka run` picks it up on every future
  commit; see "Keeping records honest over time" for what changes on
  `nuka tend` once it does.
- Don't hand-edit a written record. It exists because it was measured, not
  claimed; editing it by hand turns it back into a claim.
- Don't delete a record and redo it to get a cleaner one. Its git history
  *is* the acceptance history; a second attempt is a new commit, not a
  replacement.
