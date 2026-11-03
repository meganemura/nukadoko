# Judgments

Some criteria no compare can decide: a greeting that is "friendly to a
first-time visitor", an error that "tells the reader what to do next", a
page that "reads as finished". A Then that states one asks for a
judgment. The run reads the value and judges nothing; a judge reads it
after the run and records `meets` or `misses` with one sentence; the next
run checks, exactly, that the value it read is the one judged.

Reach for this last. A criterion a compare can state (a text, a field, a
role and a name, a count) takes the compare: it holds on every run with
no one reading it. A judgment covers only the value it cites, so every
change to that value asks for a new one.

## Writing the Then

The claim is `judged-as`. Its actual is the value to judge, its expected
the quality the sentence names, from a capture or the pattern's own words:

```ts
export default defineStep({
  pattern: "the greeting reads as {quality:string}",
  args: z.object({ quality: z.string(), stdout: runGreet.returns.shape.stdout }),
  from: { stdout: [runGreet, "stdout"] },
  claims: [{ actual: "stdout", view: "text", compare: "judged-as", expected: "quality" }],
});
```

- The value has to be one nukadoko measured: a response, a process's
  output, a file, read through `view` and `at`. A value your step code
  computed is `uncitable`, since a judge of it would judge your code.
- On a page, return the locator or the page from `observe`: the value is
  its ARIA snapshot, so a change only to how it looks keeps the judgment,
  and the judged view (`seen`: a screenshot and the ARIA file) is what the
  judge looks at beside it. `nuka check` asks for `poll` there; a judged
  value settles the poll only when two readings in a row agree.
- Not inside `each`, not with `count`, no expected from `from` or
  `observe`, no `expected_view`: `defineStep` refuses each.
- Keep a judged Then to one quality. A Then that compares something and
  asks for a judgment is two Thens.

## The run

A row whose head passed and read a value gets a `judgment` column beside
its verdict; the verdict never changes. Its states:

- `pending`: no judgment cites the value. Get one judged (below).
- `stale`: the judgments cite a value this run did not read; the reason
  names the first difference. Judge the new value; do not edit the file.
- `misses`: a judge said the value misses the sentence. Change the
  program, not the sentence or the judgment, then run and judge again.
- `uncitable`: the step reads a value no channel holds. Fix the step.
- `judged`: each value has a `meets` judgment. The run summary lists the
  row under "Held on a judgment".

Anything but `judged` fails the run with a `judgment-<state>` finding,
whose `do:` is the `nuka judge` line to run.

## Judging

The judge is not the agent that wrote the change. You read the sentence
while you wrote the code, so your reading of the value is the reading the
code was written to pass. Hand it to a person, or to a fresh agent (a
subagent with nothing of this session) given only:

1. the scenario's sentence and the quality,
2. the value, and the `seen` files for a page,

from `nuka judge <feature>:<line> --run <run-id>`, which shows them and
records nothing. Give the judge no code, no diff, and no hint of the
answer you want. The judge answers `meets` or `misses` and one sentence
why; record it, with the judge's own name:

```sh
npx nuka judge features/greeting.feature:3 --run <run-id> \
  --meets --by "reviewer agent" --because "It welcomes the visitor and asks nothing of them."
```

It writes `judgments/<feature path>.json` at the project root. Commit it
with the change: the commit and its review are the record of who judged,
since `--by` is only a name. Never write or edit that file by hand, never
judge a value yourself, and never pass `--by` a name that did not judge.
`nuka judge` refuses a value whose step record no longer has the digest
run.json recorded: run again and judge what the new run reads.

A `misses` is an answer, not an obstacle: report it to the person with
the judge's sentence, and do not look for another judge who says `meets`.

## Under --base

A new or changed criterion whose Thens only ask for judgments is `held`,
never `unproven` (no base can break a claim that compares nothing), and
its judgment decides it. The summary names the judgment files the change
brings ("A judgment file changed since the base"), so the person reviews
each judgment with the feature.
