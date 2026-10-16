# Keeping the vocabulary healthy over time

## When to run it, and what to do with the answer

`nuka check` answers whether the next run can proceed. `nuka tend` answers
a different question: whether the vocabulary and the records behind it are
rotting. A step nothing binds any more, a fixture nothing names, a field
with no description, a read that follows a navigation too closely: none of
that stops a run, so `nuka check` never mentions it. `nuka tend` is what
finds it, and it never gates the acceptance loop.

A step file that failed to import is a different report. `nuka tend` adds
the note `import-failures-unseen`, because that file's steps are missing
from every count and finding it prints. `nuka check` names the cause as
`step-file-import-failed`. Fix that import first; the rest of the tend
report is not complete until it is.

Run `nuka tend` once after the pull request is open, when you report it.
That is the moment where nothing depends on the answer: the work is done,
the run summary is on the pull request, and the user is reading a result
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

Every finding `nuka tend` reports is a note a project is allowed to carry
rather than something blocking, so it exits 0 by default. A job that must
block on one of them passes `--fail-on <code>` (for instance
`pattern-unbound`); the finding stays a note in the output, and only that
invocation's exit code turns red. The code to pass is the one printed
beside each finding.

`repeated-scenario-prefix` shows which scenarios in the most recent run
shared the same opening steps. It also shows the measured time for that
opening and its share of the run's summed scenario time.

`post-navigation-read` is the one worth knowing the shape of, because
there is a way to make it stop being true and only one. It reads every
step record under `.nukadoko/records/steps/`, so a step that has only been
exercised with `nuka do` still shows up here. It lists a call a step made
shortly after its own navigation, and it never says the gap was too short,
since how long an application takes to render after a navigation is not
something this tool can know. A read that a `poll` call was already
retrying is not listed at all. Reaching for a direct browser wait instead
does not help: that wait is itself a call right after the navigation, so
the note comes back naming it, which reads as though nothing silences it.

Once a feature has moved into `featuresDir` (see "What not to do" in
`SKILL.md`), `nuka run` picks it up on every future commit, and each of
those runs writes its own run summary. A feature kept outside
`featuresDir` and listed in `additionalFeatureDirs` still counts for the
steps it binds, so `pattern-unbound` and `fixture-unused` do not report
its steps as dead, but nothing runs it unattended.
