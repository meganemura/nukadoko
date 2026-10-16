# Diagnosing a failed run

## Work through the failed step first

`nuka run`'s stderr already names where to start: under the failed step's
`FAIL` line, the first line of its error and the path of its step record
(`record  <stateDir>/records/steps/<id>`), and after the summary, a `rerun`
line per failed scenario with the command that runs that scenario alone.
When the failed step read from a step whose program exited nonzero, a
`used    <step>  exit <code>  <first stderr line>` line sits between the
two: a Then step that got an empty stdout usually failed there, because
the program did not start (a missing build, a missing dependency, a `.js`
import of a `.ts` file under `node`), and the step that ran it passed.
`--quiet` keeps all of these. Open that path's `record.json` rather than
searching the records directory.

Before repeating `nuka run <feature>`, read the failed step's own step
record in this order. The sections below are how to read the items that
need more than a glance.

1. Its `used` entries: each carries the full validated `result` of the
   upstream step it read from, sitting right on the step record that
   failed.
2. `actions`, then the rest of the timeline ("Reading a step record as a
   timeline"): every Playwright call this step made through the `page`
   fixture, `expect` waits included, each with its own duration and
   outcome.
3. `page_events`, if the step opened a browser: a console error, an
   uncaught page error, or a failed request recorded there can explain a
   failure nothing else on the step record mentions.
4. `nuka do <step> --use <upstream-step-record-id>` when the record
   sharpens a hypothesis rather than confirming it ("Testing a hypothesis
   without a full re-run").
5. Re-run the scenario last, with the `rerun` line `nuka run` printed,
   once the step itself passes under `do`, not as the first thing tried
   after a failure.

## Reading a step record as a timeline

Read the failed step's own step record as one timeline rather than a bag of
separate fields: `started_at`, `finished_at`, `sections[].at`, `polls[].at`,
`actions[].at`, and `evidence.screenshots[].at` all share the same clock, so
sorting them together turns the step record into an ordered account of what
happened when.

```sh
jq -r '([{at: .started_at, event: "started"}, {at: .finished_at, event: "finished"}]
  + (.sections // [] | map({at, event: "section:\(.label)"}))
  + (.polls // [] | map({at, event: "poll:\(.description // "poll")"}))
  + (.actions // [] | map({at, event: "action:\(.method) (\(.ms)ms, \(.outcome))"}))
  + (.evidence.screenshots // [] | map({at, event: "screenshot:\(.file)"})))
  | sort_by(.at)[] | "\(.at)  \(.event)"' record.json
```

`actions` is every Playwright call this step made through the `page`
fixture, `expect` waits included, each with its own duration and outcome,
read straight off the step's own trace: an `expect` that timed out shows up
here with `outcome: "failed"` and a real `ms`, often enough to explain a
failure without opening the trace viewer at all.

If the step opened a browser (destructured `page`), also check
`page_events` on that step record: a console error, an uncaught page error,
or a failed request recorded there can explain a failure nothing else on
the step record mentions, since it comes from the page itself rather than
anything the step declared.

## The `final.png` and absence claims

If an absence claim turns up on that timeline, check whether its own moment
sits before whatever readiness evidence the step returned alongside it.
Earlier means the read landed before the page was ready to be read,
premature, not a state problem to go chase in the app. Don't trust
`final.png` to show the moment of failure either: it's taken once the step
has already returned or thrown, during teardown, so compare its `at`
against `finished_at` rather than the screenshot's contents alone (a gap of
several seconds between them reads, at a glance, like state that was
flickering, and it has been misdiagnosed as exactly that). Reach for the
trace only when the DOM itself is what's in question: `npx playwright
show-trace <evidence.dir>/trace.zip`. That trace is this one step's own
window now, not the whole scenario's recording, so what it shows is exactly
this failure, nothing earlier in the scenario to scrub past first.

## A step that timed out

`error.kind: "timeout"` on a typed step means its `run` passed its
deadline: `stepTimeout` in `nukadoko.config.ts` (twenty minutes unless the
project sets it), or the step's own `defineStep({ timeout })`, which
`nuka describe <step>` shows when it is declared. The error message names
which one fired. Before raising either, read the timeline: the last
`sections` label says which stage the step was in when the deadline
passed. A wait on something that will never happen only fails slower
under a longer deadline. Raise the step's own `timeout` only when the step
is slow by design, and `stepTimeout` only when most steps are.

## Testing a hypothesis without a full re-run

If a step record only sharpens a hypothesis rather than confirming it, test
the hypothesis with `nuka do <step> --use <upstream-step-record-id>`
instead of re-running the scenario. It executes the one step in question,
seconds, where a full `nuka run` costs minutes, and it still counts toward
the same three-fix-and-retry-cycles rule in `references/writing-steps.md`
("When the vocabulary has no step for it").

Re-run the whole feature last, once the step itself passes under `do`, not
as the first thing tried after a failure. Repeating `nuka run` end to end
is the expensive way to learn what a single step record, or a single `do`
call, would already have told you.
