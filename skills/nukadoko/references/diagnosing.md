# Diagnosing a failed run

## A command that refused

A command that stopped before it ran anything exits 2, not 1, and prints one
`refused` finding with a code, such as
`refused\ttarget-not-found\t-\t<message>`; under `--json` it is in the
envelope's `findings`, and `verdict` is `refused`. Make the edit its `fix:` line
names, or run its `do:` line, before you guess at a fix: the `do:` is the step
list for an unknown step name, the install line for a missing package, or the
command's own `--help` for a flag it does not accept.

## Work through the failed step first

`nuka run`'s stderr already names where to start: under the failed step's
`failed` line, the first line of its error and the path of its step record
(`record  <stateDir>/runs/<run_id>/steps/<id>`), and after the summary, a
`failed\tscenario-failed\t<file>:<line>\t<name>: <error>` finding per
failed scenario, whose `  do:` line runs that scenario alone.
The same list is in the run's `run.json` (`nuka run --json` prints it):
each entry of `scenarios` with `status: "failed"` names its `do` command,
and its failed step names its `line`, its `error` (`kind`, `message`),
its step `record`, and the `used` results it read (a large one cut to a
preview marked `truncated`; the producer's `record` holds it whole).
When the failed step read from a step whose program exited nonzero, a
`used    <step>  exit <code>  <first stderr line>` line sits between the
two: a Then that claimed against an empty stdout usually broke there, because
the program did not start (a missing build, a missing dependency, a `.js`
import of a `.ts` file under `node`), and the step that ran it passed.
When that program was Node and it crashed, the line shows the `Error:`
line, not the location Node printed above it. A program that wrote its
refusal on stdout and nothing on stderr (as under `--json`) shows
`stdout: ` and what it printed there.
A Then that failed with `claim_broken` prints its claim line: both
values and where each came from. Check that the actual value's source is
the thing the criterion means before you suspect the implementation; the
step record's `claims` give each claim's `measured`, the channel that
holds the raw value. `unobserved` means `observe` threw, so no claim was
judged. A claim step's `timeout` leaves each claim `unjudged`, beside the
readings read before the deadline. `claim_unjudged` means nukadoko itself failed while judging (its
reason names the failure): nothing is known about that criterion yet. Open that path's `record.json` rather than
searching the records directory.

Before repeating `nuka run <feature>`, read the failed step's own step
record in this order. The sections below are how to read the items that
need more than a glance.

1. Its `used` entries: each carries the full validated `result` of the upstream
   step it read from, sitting right on the step record that failed.
2. `actions`, then the rest of the timeline ("Reading a step record as a
   timeline"): every Playwright call this step made through the `page` fixture,
   `expect` waits included, each with its own duration and outcome.
3. `page_events`, if the step opened a browser: a console error, an
   uncaught page error, or a failed request recorded there can explain a
   failure nothing else on the step record mentions.
4. `program-log.txt` beside the record, when `observed.program_log` names it,
   and `program-log-late.txt` when the run summary names one: the lines the
   program under test wrote for this step's own requests, such as the error
   behind a 500, and `events.jsonl` when `observed.events` names it: each
   statement, job, and call it made (`program.md`).
5. `nuka do <step> --use <upstream-step-record-id>` when the record
   sharpens a hypothesis rather than confirming it ("Testing a hypothesis
   without a full re-run").
6. Re-run the scenario last, with the `do:` line `nuka run` printed, once the
   step itself passes under `do`, not as the first thing tried after a failure.

## Reading a broken claim

```text
claim broken: "food: 5.5\nrent: 100" (from:run-tally@16.stdout as text) equal "food: 5.5\nrent: 101" (sentence:expected); first difference at line 2: actual "rent: 100", expected "rent: 101"
```

The actual value and its source, the compare, the expected value and its source,
then where the two part. A broken `has-same-items`, or `equal` on two lists with
an item inserted or removed, names the expected items that are missing and the
actual items that are extra, each with its index on its own side
(`; 1 actual item is extra: ["4","chair","2"] (item 3)`), so an inserted row is
one extra item, not a difference at every row after it. The step fails with
`claim_broken`, and the run summary lists every claim under "Claims" with its
outcome. A broken claim is fixed in the implementation or by asking the person,
never by a weaker compare.

A polled claim that broke says why its poll stopped. `; the poll stopped on
reading 4, before its 5000 ms timeout, since readings 3 and 4 settled (screen
equal "scoring")` means the page reached the state the step declares final;
`the poll read until its 5000 ms timeout, and no two consecutive readings
settled` means it never did. Each reading's `settled` in the record says which.

A claim on a count of execution events ends with what the count counted,
grouped by what each line reports, whatever the outcome:

```text
claim broken: 1 (events:open-room@4 count db where op in [insert, update, delete, other], committed true) equal 0 (literal:nothing); counted 1 line: db insert into events
```

`events_read.<key>.counted` in the step record lists every group, and
`events-read.jsonl` holds each line. A group the sentence does not mean is
a question for the person. A table the program writes for its own
bookkeeping (a telemetry row) or to run (a cache entry, a migration row) is
the program's to declare: a `lists.tables` command prints
`{"table":"events","holds":"bookkeeping"}` (or `"infrastructure"`) from
where the program already says it, never from a list in the program file,
and a `db` count that names no `table` then leaves those lines out. The
line ends `left out 1 line: db insert into events (bookkeeping)`, and
`events_read.<key>.left_out` names each group. Otherwise the implementation
stops the write, or the step's `count` names the tables the sentence means.
A held count is read the same way, since it may have counted the wrong
table or left out the one the sentence means. A tables list that was not
read (`program-list-unread`) leaves such a count `unjudged`
(`holds_unknown`): fix the command first.

The note `undeclared-write` (`nuka run`) names a step that declares
`mutates: false` whose trace holds a write the program committed to a
table that holds state, with the table and the op. The declaration or the
program is wrong; ask the person which before changing either.

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

If the step opened a browser (destructured `page`), also check `page_events` on
that step record: a console error, an uncaught page error, or a failed request
recorded there can explain a failure nothing else on the step record mentions,
since it comes from the page itself rather than anything the step declared.

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
A `pageAs(name)` context records apart from the default one: its trace is
the `evidence.named_traces[]` entry whose `as` is that name, with `file`
naming `trace.<name>.zip`, and its screenshot is `final.<name>.png`.
A step that only called an API has no page to show. With `showRequests:
true` in `nukadoko.config.ts`, `evidence.requests_trace` names a trace
(`requests.zip`) whose screen shows each request the step sent and the
body that came back, redacted as http.jsonl is. http.jsonl holds the same
facts as text, and is quicker to read.

A Then that read a page while a request to the world was in flight says so on
its summary line (`read with a request in flight`, each request with the step
that sent it), and its record's `pages` name each page's `last_response` and
`in_flight` in `page_requests`. A claim that broke there may have read the page
before the answer it needed: poll the Then (`checking-steps.md`), or have the
When wait for what it started. This is an order, never what the page drew.

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
