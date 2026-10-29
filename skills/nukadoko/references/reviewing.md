# Walking a person through a scenario, one step at a time

Use this when the person wants to check that each step does what its
sentence says, with you beside them, instead of reading the run summary
alone. The raw output of a step (a JSON result, a list of files, an HTTP
log) is rarely enough for a person to judge. Your job in the walk is to
read that output for them, say what it means, and show where you read it.

## 1. Start the walk

```sh
npx nuka check features/checkout.feature
npx nuka run features/checkout.feature:12 --step    # in the background
npx nuka step wait
```

`--step` runs one scenario in one environment, and after each step it
pauses with the world, the browser, and the fixtures still open until a
`nuka step` call answers. Start it in the host's background mode (in
Claude Code, `run_in_background`), since it does not return until the
walk ends. `nuka step wait` waits up to `--timeout` seconds (default 90)
and prints where the walk stands:

```
walk 1 paused after step 1/4 (passed): the shopper opens the cart
  scenario: features/checkout.feature:12 Pay for a cart (default)
  record: .nukadoko/runs/<run_id>/steps/<id>/record.json
  view: page 1 http://127.0.0.1:41233/cart "Cart": <run_dir>/pauses/1/page.png <run_dir>/pauses/1/page.aria.yml
  world: http://127.0.0.1:41233
  do: nuka step next 1 --walk 1   (or: nuka step stop 1 --walk 1)
```

`--json` gives the same as fields: `walk`, `pause` (`pause`, `of`,
`line`, `text`, `step`, `status`, `record`, `failure` when the scenario
failed there, `remaining`, `paused_at`, `views`), `run_id`, `run_dir`,
`scenario`, `world`, and `do`. A wait that prints `starting` or
`running` ran out before the walk paused: run it again. A run that
refused (more than one scenario, say) never pauses, and a wait shows it
ended before its scenario ran. A wait reports each end once, then waits
for the next walk; `nuka step wait --walk <w>` shows that walk again.

## 2. Gather one step

For each pause, before you say anything about the step:

- The sentence: the pause's `text`, with its `line`.
- The contract: `npx nuka describe <step>` gives its `description`,
  `mutates`, `from`, `args`, `returns`, and `file`, the step file to read.
- The record: `<run_dir>/<record>/record.json`. Read `args`,
  `args_origin`, `result` (or `error` when it failed), `mutates`,
  `observed`, `used`, `calls`, and `evidence`.
- The views: each open page as the step left it, `page.png` for the
  person and `page.aria.yml`, its accessibility tree, for you
  (`page-2.*`, `page.<name>.*` for a second page or a `pageAs` context),
  taken after the step's record. What a page sent while the walk waited
  is in `pauses/<n>/http.jsonl`, not in the step's.
- The world, when there is one: its URL is live, so you can read it, but
  anything you change there is what the next step finds.

What each part of `observed` says (a `null` channel means nothing was
measured there, not that nothing happened):

- `processes` lists each `runCommand`, with its command, `cwd`,
  `exit_code`, `files` (what it added, changed, or removed under its
  working directory), `stdout` and `stderr` (the files in the record's
  directory that hold what it printed), `stdin` (the file that holds what
  it was given), and `env` (how its environment differed from the
  runner's: each name, with a value only when it is an existing absolute
  path, a decimal integer, or a boolean, else its `hidden_bytes`).
- `http` counts the requests the step sent. Each is a line in
  `http.jsonl` with its method, URL, status, request body, and response
  body. A line marked `after_step_end` started after the record was
  written, so the record does not count it; the run summary names it and
  its file. A body marked `incomplete` was still arriving when nukadoko
  stopped waiting; one with an `error` failed on its own. A line's
  `traceparent` is the value the request went out with, nukadoko's or
  the step's own, and `traceparent_sent_to` the origins that received
  it; nukadoko's value names the id the program's log lines carry.
- `program_log` counts the lines of the program's log that carry the
  step's trace id, in `program-log.txt` beside the record: what the
  server did for this step. Lines that arrived after the step ended are
  in `program-log-late.txt`, and the run summary names them. `lines: 0`
  with `stamped` above 0 is explained by the run summary's line for the
  world (`program.md`); `null` means the world runs at a `url`.
- `files` lists the paths the step changed in a scratch directory or
  wrote through `node:fs`, each with its content after the step. A file
  the step asked Playwright to write (a screenshot saved to a path, a
  trace from `tracing.stop({ path })`) is listed; what Playwright's
  server writes on its own (trace chunks, a HAR, a video) is not, whoever
  launched the browser.
- `unmeasured` lists what the step did that nukadoko saw but cannot
  measure: a process started without `runCommand` (its program and
  argument count only), a `Worker`, a connection that carries no recorded
  request, a UDP datagram, a written path nukadoko could not inspect. The
  record has no evidence of what such an action did, so a claim that rests
  on it is cannot tell. An empty list is not proof that nothing else
  happened: a child process's own traffic is never seen.

The other fields:

- `args_origin` says where each argument came from (a capture, the
  docstring, the table, an earlier step's result, the command line, or
  the schema), which names the input to fix when an argument is wrong.
- `used` names the earlier step records this step read through `from`,
  and the values it took from them.
- `evidence` points at the screenshots, the trace, `http.jsonl` (each
  request the step or its page sent), and any attachment the step made.
  Name the file the person can open.

## 3. Judge it with fresh eyes

The agent that wrote a step reads its own intent into the record. When the
host can start a subagent, give one only the sentence, the step file, and
the record, and ask whether what was measured does what the sentence
says; without a subagent, judge it yourself from the record alone and
say so. Expect one of four answers, each citing the field it rests on:

- **matches**: the record shows the sentence happening, and nothing else.
- **does less**: part of the sentence has no trace in the record (a Then
  whose claims read something other than what the sentence names, a When
  whose process exited before it did the work).
- **does more**: the record shows work the sentence does not name (a
  write under a `mutates: false` declaration, a file the sentence never
  mentions, a request to another endpoint).
- **cannot tell**: the evidence does not reach the claim (an
  `observed` channel that is `null` or an entry in `observed.unmeasured`
  where the claim needs evidence, a result that only echoes an argument).

A claim's `measured` names the channel in the record that holds the raw
value it compared, and the run summary prints it on the claim's line as
`measured: <channel>` or `measured: none`. `none` is what a constant in
step code looks like, and also a value read out of a larger body (one key
of a JSON response), so it is a place to look, not a verdict. An expected
value that came from `from` or `observe` gets the same after it, `expected
measured: <channel>` or `expected measured: none`, and `none` there is
what a When step that returns the value its Then compares with looks like.
A scenario under "Scenarios with no claim" ran with no claim on a Then
line judged, and a run with `check: skipped` started past `nuka check`. A
Then whose `observe` reads a file and claims on it often comes back as
cannot tell, with `measured: null`: the record keeps what a process
printed and the files it changed, and nothing of a file the step read
itself. That is a gap in the evidence, not a wrong step. Have `observe`
attach what it read with `evidence.attach` (`evidence.md`), run again, and
the next walk can show it.

## 4. Show one step, then wait

Tell the person, in their language and in plain words:

1. The sentence.
2. What happened, in a sentence or two, from the measured fields: "init
   wrote 11 files under the project, among them `modules/orders/module.ts`,
   and exited 0". Describe the measurement, not what the code meant to do.
   When `used` is present, say what the step took from which earlier step:
   "it ran in the `project` that installing solarsql returned".
3. The verdict from step 3 and the field it rests on.
4. What to open to confirm it: the pause's `page.png`, a line of
   `http.jsonl`, a file the process wrote.

Then stop and wait for the person. Never answer a pause they have not
answered: the run waits exactly so that they judge each step while its
world is still there. Answer with the pause number they saw and the walk
number it printed (`walk 1 paused ...`), as the `do` line spells it:

- To go on: `npx nuka step next <n> --walk <w>`. It runs the next step
  and prints the next pause, or the end after the last step.
- To stop: `npx nuka step stop <n> --walk <w>`. The steps after it do not
  run, After hooks and teardown do, and the record says the scenario was
  `stopped` at that step, not that it failed (`walk-stopped`).

A call whose output you lost, or that printed `starting` or `running`,
is safe to run again: an answer is written once, and the same answer
again prints what followed it. `pause-answered` means another answer
reached that pause first, `pause-not-current` that the walk is
elsewhere, and `walk-not-current` that a later walk replaced the one
the answer names: show the person what the `nuka step wait --walk <w>`
of its `do` prints before you answer again. A pause where the scenario
failed (a step, or an AfterStep hook after it) prints `failure:`, exits
1 with `walk-failed`, and offers only `next`: show the failure and the
views, answer `next` once the person has seen them, and go to
`diagnosing.md`. A walk a signal ended (the host's background limit,
Ctrl-C) prints `interrupted`; one whose run was killed prints
`walk-gone`, and its `do:` starts it again.

A walked run is not the run a reviewer approves (the world and the
browser were open between steps, and its summary says so): when the
walk is done, run the scenario once more without `--step`.

## 5. When the person disagrees

Stop the walk at that pause (`nuka step stop <n> --walk <w>`) before you change
anything. The fix goes in the step file or the feature, never in the
record: a hand edit turns a measurement back into a claim. To show a
variation of one step without rerunning the whole scenario, `nuka do
<step> --use <step_record_id>` runs it alone on the same upstream values;
that is a working record, not evidence. After the fix, start a new walk;
with the person's word, answer `next` through the steps they already
accepted, up to the first step whose file or sentence changed. A Then
the person rejects is fixed in the implementation or by their word, not
by weakening the Then.
