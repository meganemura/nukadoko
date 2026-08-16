# Diagnosing a failed run

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

## Testing a hypothesis without a full re-run

If a step record only sharpens a hypothesis rather than confirming it, test
the hypothesis with `nuka do <step> --use <upstream-step-record-id>`
instead of re-running the scenario. It executes the one step in question,
seconds, where a full `nuka run` costs minutes, and it still counts toward
the same three-fix-and-retry-cycles rule described under "When an operation
is missing" in `SKILL.md`.

Re-run the whole feature last, once the step itself passes under `do`, not
as the first thing tried after a failure. Repeating `nuka run` end to end
is the expensive way to learn what a single step record, or a single `do`
call, would already have told you.

## When accept refuses

`accept` always says which refusal condition fired, in stderr, along with
the next command to run. Read that message and act on it, don't guess, and
don't look up the list elsewhere first: stderr is the source of truth here
and anything written in this file would just go stale next to it. One
shape worth knowing ahead of time: "no run to freeze" can mean a green full
run of the feature exists, just not under the current condition. That
refusal names the condition it looked for and lists every condition that
does have a run, so the next move is either `nuka run <feature>` again
under the current condition or pointing `accept`'s own `--env` and/or
`browserType` in the config at one of the ones already listed, never a
guess between them.
