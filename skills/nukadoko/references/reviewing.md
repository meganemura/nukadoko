# Walking a person through a run, one step at a time

Use this when the person wants to check that each step does what its
sentence says, with you beside them, instead of reading the run summary
alone. The raw output of a step (a JSON result, a list of files, an HTTP
log) is rarely enough for a person to judge. Your job in the walk is to
read that output for them, say what it means, and show where you read it.

## Why it is a walk over one run

Run the scenario once, then walk its step records in order. Each step
record already holds what that step received, what it returned, and what
nukadoko measured it doing, in the one world the scenario gave all of its
steps. A run that paused between steps would show nothing more: the world
is torn down when the run ends either way, and a record you read after
the run is the same record you would have read mid-run. Only a real run
from nothing is evidence, so the walk adds no state of its own.

## 1. Run it once

```sh
npx nuka run features/checkout.feature:12 --probe --json
```

`--json` prints `run.json`. Take the scenario's `steps` in order: each has
its `line`, its `text`, the `step` it matched, its `status`, and `record`,
the step record's directory under `run_dir`. `--probe` adds `probes`: a
Then that still passes with its capture changed is worth naming when the
walk reaches it. A `:line` target makes `selection` partial, which is
fine for a walk and is not the run a reviewer approves.

## 2. Gather one step

For each step, before you say anything about it:

- The sentence: the step's `text` in `run.json`.
- The contract: `npx nuka describe <step>` gives its `description`,
  `mutates`, `from`, `args`, `returns`, and `file`, the step file to read.
- The record: `<run_dir>/<record>/record.json`. Read `args`, `result`
  (or `error` when it failed), `mutates`, `observed`, `used`, `calls`, and
  `evidence`.

What each part of `observed` says:

- `http_reads` and `http_writes` count requests through `request`,
  `page`, `context`, or `pageAs`. `null` means nothing was measured, not
  that nothing happened.
- `processes` lists each `runCommand`, with its command, `cwd`,
  `exit_code`, `files` (what it added, changed, or removed under its
  working directory), and `stdout` and `stderr`: the files in the
  record's directory that hold what it printed.
- `used` names the earlier step records this step read through `from`,
  and the values it took from them.
- `evidence` points at the screenshots, the trace, `http.jsonl`, and any
  attachment the step made. Name the file the person can open.

## 3. Judge it with fresh eyes

The agent that wrote a step reads its own intent into the record. When the
host can start a subagent, give one only the sentence, the step file, and
the record, and ask whether what was measured does what the sentence
says. Expect one of four answers, each citing the field it rests on:

- **matches**: the record shows the sentence happening, and nothing else.
- **does less**: part of the sentence has no trace in the record (a Then
  that reads a value but asserts nothing about it, a When whose process
  exited before it did the work).
- **does more**: the record shows work the sentence does not name (a
  write under a `mutates: false` declaration, a file the sentence never
  mentions, a request to another endpoint).
- **cannot tell**: the evidence does not reach the claim (an
  `observed` that is `null`, a result that only echoes an argument).

Without a subagent, judge it yourself from the record alone and say so.

A Then that reads a file or a process output and asserts on it often
comes back as cannot tell when the step only read a file: the record
keeps what a process printed and the files it changed, and nothing of a
file the step read itself. That is a gap in the evidence, not a wrong
step. Have the step
attach what it asserted on with `evidence.attach` (`evidence.md`), run
again, and the next walk can show it.

## 4. Show one step, then wait

Tell the person, in their language and in plain words:

1. The sentence.
2. What happened, in a sentence or two, from the measured fields: "init
   wrote 11 files under the project, among them `modules/orders/module.ts`,
   and exited 0". Describe the measurement, not what the code meant to do.
   When `used` is present, say what the step took from which earlier step:
   "it ran in the `project` that installing solarsql returned".
3. The verdict from step 3 and the field it rests on.
4. What to open to confirm it: a screenshot, a line of `http.jsonl`, a
   file the process wrote.

Then stop and wait for the person before the next step. Do not batch
steps to save turns: the point is that they judge each one while it is in
front of them. A failed step ends the walk there: show its `error` (its
`kind` and message) the same way, and go to `diagnosing.md` once the
person has seen it.

## 5. When the person disagrees

The fix goes in the step file or the feature, never in the record: a hand
edit turns a measurement back into a claim. To show a variation of one
step without rerunning the whole scenario, `nuka do <step> --use
<step_record_id>` runs it alone on the same upstream values; that is a
working record, not evidence. After the fix, run the scenario again from
nothing and resume the walk at the first step whose file or sentence
changed. A Then the person rejects is fixed in the implementation or by
their word, not by weakening the Then.
