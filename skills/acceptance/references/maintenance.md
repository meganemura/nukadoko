# Keeping records honest over time

## When to run it, and what to do with the answer

A record freezes the feature source and the run's step records, but not
the contracts behind them. Change a step's `returns` after accepting, edit
the feature, or delete a step it cites, and the record still claims a
green run it can no longer support. Nothing about that stops a future
run, so `nuka check` never mentions it. `nuka tend` is what finds it. It
answers whether the vocabulary and its records are healthy, not whether
this run can proceed, so it never gates the acceptance loop. The fix is
to run and accept the feature again, or to undo what invalidated the
record, never to edit the record.

Run `nuka tend` once after `nuka accept` succeeds, when you report the
sign-off. That is the moment where nothing depends on the answer: the
work is done, the record is written, and the user is reading a result
rather than waiting on one. "Periodically" names no moment an agent can
recognize, so an instruction that says only that gets `nuka tend` run
never.

Report what it found and stop there. Each finding is about something the
user chose, so acting on one without being asked replaces their choice
with yours. Two shapes come up often enough to name here; the rest of
this file is what each finding actually means. A step nothing binds any
more is usually a deletion someone forgot to finish, and a fixture
nothing names is usually setup that outlived the scenario that needed it.
Say which findings you would act on and what each would change, then
wait. Nothing here is urgent; a finding that has waited a week can wait
for an answer.

## What it reports

`nuka tend` finds a record whose claims stopped holding: a stale record is
the only finding that exits non-zero, so a periodic job can act on it; read
what it prints for which of the record's own claims stopped holding and how
to fix it. Every other finding it reports, `signoff-condition-mismatch` and
`post-navigation-read` among them, is a note a project is allowed to carry
rather than something blocking. A job that must block on one of them
passes `--fail-on <code>` (for instance `feature-never-signed`); the
finding stays a note in the output, and only that invocation's exit code
turns red.

Re-taking a record never means deleting the old one first. A record's name
carries the commit it froze, so a fresh `nuka accept` writes a new file
beside the old one. Deleting first is worse than unnecessary: `accept`
sets an existing acceptance record aside when it checks for a dirty tree,
which is why a second feature can be accepted without committing the
first one's record, but a *deleted* record cannot be read and so cannot be
recognised as one. It counts as an ordinary dirty path, and `accept`
refuses. Delete an old record when `nuka tend` reports
`signoff-feature-changed` against it, which is when it has stopped being
true, and not before.

`repeated-scenario-prefix` shows which scenarios in the most recent run
shared the same opening steps. It also shows the measured time for that
opening and its share of the run's summed scenario time.

`post-navigation-read` is the one worth knowing the shape of, because
there is a way to make it stop being true and only one. It reads every
step record under `.nukadoko/records/steps/`, not only the ones an
accepted record has frozen a copy of, so a step nobody has signed off yet
still shows up here. It lists a call a step made shortly after its own
navigation, and it never says the gap was too short, since how long an
application takes to render after a navigation is not something this tool
can know. A read that a `ctx.poll` call was already retrying is not
listed at all. Reaching for a direct browser wait instead does not help:
that wait is itself a call right after the navigation, so the note comes
back naming it, which reads as though nothing silences it.

Once a feature has moved into `featuresDir` (see "What not to do" in
`SKILL.md`), `nuka tend` stops reporting a stale sign-off or a drifted
condition for it: the running suite carries the guarantee now, not a
record frozen at one commit, and reporting either finding anyway would
turn every ordinary edit to a feature already running unattended into an
alarm nobody keeps reading. The one exception is a record `tend` cannot
even parse (`signoff-record-unreadable`): its own claimed feature path may
not have parsed either, so there is no placement to judge it by, and a
file that looks like a record but cannot be read stays worth reporting
regardless of where the feature lives.

`signoff-rot` and `signoff-condition-mismatch` above both start from a
record that already exists and ask whether its claim still holds. One
more starts from the opposite end:
`feature-never-signed` names a feature under `featuresDir` or
`additionalFeatureDirs` that no acceptance record's own `feature:`
frontmatter has ever named. `nuka accept` has no way to force a red run
through; it refuses and names the next command to run, which means the
usual way sign-off actually fails is that nobody runs it at all, and that
shows up in a PR as a file that is not there. Nothing else here looks for
a file that is not there. It is a note, not an error, the same reason a
feature still being drafted is a normal thing to see: `nuka accept` is a
later, explicit step, so a feature with no sign-off yet may simply not
have reached it. Being inside `featuresDir` does not silence this one,
unlike the two staleness findings above: whether a record was ever made
is a different question from whether a frozen one is still accurate, and
the running suite answers only the second.
