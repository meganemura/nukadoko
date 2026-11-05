# Answering a reviewer's merge-risk questions from a run

Use this when a person, or a review tool, asks how risky a change is
before they merge it. A common rubric asks five questions: is the change
verified, does it do only what it says, what does it touch, how hard is
it to undo, and will its failures be seen. A model that scores those
questions from the diff guesses. `nuka run --base` already measured most
of the answers, so read them from its run.json and say plainly which
parts it did not measure.

## 1. Run against the base

```sh
npx nuka run --base origin/main
jq -r --argjson sensitive '["payments", "/admin/:id"]' \
  -f node_modules/nukadoko/skills/nukadoko/scripts/merge-risk.jq \
  .nukadoko/runs/<run_id>/run.json
```

Every answer below except Verification is a difference between the base
world and head, so a run without `--base` gives no answer. The script says
so and stops.

`sensitive` lists the tables and routes this project treats as sensitive:
auth, permissions, billing. Take the list from the project (its
CODEOWNERS, its docs, or the person), not from table names. A list you
made up is a guess the output then repeats as a fact. Leave it out when
there is none, and the output says no list was given.

## 2. Read each answer

The script prints one section for each question. Each line is a fact the
run measured, or a line that names what it did not measure.

**Verification.** Each criterion's verdict from the table
(`references/verdicts.md`). A `held` verdict on a criterion that judges no
claim proves no outcome, so the script names it. `failed` and `unproven`
rows are not risk to weigh: fix them before the change goes to review.

**Alignment.** Each INTENT.md row and its result (`references/done.md`),
then each difference that no row, no sentence, and no new or changed
criterion explains. A line under "declared nowhere" is a change the
author did not say they meant: a fix in passing, or a side effect. When the
change has an INTENT.md, the run already fails on it as
`intent-unintended`. Remove the change or declare it.

**Impact.** The tables and routes that head touches differently from the
base, and the sensitive ones among them. This section reads every
difference, including those a criterion explains: a new criterion that
deletes rows explains its own difference, but the delete is still what a
reviewer wants to see first.

**Rollback cost.** The deletes and updates that are new at head. Data the
change removes or overwrites is harder to restore than a row it adds. The
run does not see schema changes, backfills, or anything outside the
program's execution events, and the script says so on every run. Read the
migration files yourself for those, and say that you read them.

**Error detection.** Unexpected failures (`references/verdicts.md`), the
unhandled errors new at head, and the errors the program caught and
passed over that are new at head. Execution events have no field that
says an error reached monitoring, so for a caught error the run cannot
tell a swallowed error from a reported one. Say that, and point the
reviewer at the place in the code that catches it.

## 3. Report it

Give the person the script's output as it printed it, then one sentence
for each section that names what to look at first. Do not turn it into a
score. A number adds nothing the lines do not say, and it hides which
parts were measured and which were not.

When a review tool reads the output, pass it the lines, not your summary
of them.
