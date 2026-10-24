# Keeping the vocabulary healthy over time

## When the notes appear, and what to do with them

`nuka check` with no target reports errors, warnings, and notes. Its errors
answer whether the next run can proceed. Its notes answer a different
question: whether the vocabulary and the records behind it are rotting. A
step nothing binds any more, a fixture nothing names, a field no
description explains: none of that stops a run, so a note never changes the
exit code, and acting on one is not a step of the acceptance loop.

A `nuka check` with targets, and the check `nuka run` runs before it
executes, print no notes: whether a step is bound depends on every feature
the project scans, so only the whole-project check can say.

A step file that failed to import is an error, `step-file-import-failed`,
and the notes count only the steps that imported, so they leave that
file's steps out. Fix that import first; the notes are not complete until
it is. When the finding ends with `; <path>.js stands for
<path>.ts, which does not exist; update the import in <file>`, a step file was
renamed or deleted under an import that still names it: point the import
in the file it names at the new file, or remove it.

Report what the notes say and stop there. Each note is about something the
user chose, so acting on one without being asked replaces their choice
with yours. Two shapes come up often enough to name here; the rest of
this file is what each note actually means. A step nothing binds any
more is usually a deletion someone forgot to finish, and a fixture
nothing names is usually setup that outlived the scenario that needed it.
Say which notes you would act on and what each would change, then
wait. Nothing here is urgent; a note that has waited a week can wait
for an answer.

## What it reports

A note is something a project is allowed to carry rather than something
blocking, so notes alone exit 0. A job that must block on one passes
`nuka check --fail-on <code>` (for instance `pattern-unbound`); the finding
stays a note in the output, and only that invocation's exit code turns to
1. The code to pass is the one printed beside each note, or one from
`nuka check --codes`, which lists every code with its severity and a
one-line meaning before any of them has fired. Each note also names a file
and a `fix:` line: what to open, and the change to make if the note calls
for one.

Every whole-project check reports every note, `schema-field-undescribed` (a
field with no `.describe()`) included. A gate that acts on some notes and
not others filters the `--json` envelope's `findings` by `severity` and
`code`, or passes `--fail-on` for each code it acts on.

`step-description-todo` names a typed step whose description is still
the `TODO: describe <name>` that `nuka scaffold` wrote without
`--description`. The step runs, so nothing else says so, but `nuka steps`
and `nuka describe` show that TODO to whoever picks a step. Write what the
step does in its place.

`nuka run` ends with a `repeated-scenario-prefix` note when scenarios of
that run shared the same opening steps; the note never changes the run's
exit code. It shows the measured time for that opening and its share of
the run's summed scenario time. An opening ends
before the first When, and two steps share it only when their docstring
or table is the same too. The note names the same opening on every run:
the one that covers the most step executions, not the slowest. It names a
process-scope fixture only when every shared step declares
`mutates: false`. Otherwise it names the first step that may write: an
opening that creates the record each scenario then reads by id stays in
each scenario (`scenario-rules.md`, S8, and `examples/http-api.md`). A
step that keeps the default `mutates: true` but writes nothing a later
scenario reads is the one case to judge yourself.

Once a feature has moved into `featuresDir` (see "The loop" in
`SKILL.md`, step 6), `nuka run` picks it up on every future commit, and each of
those runs writes its own run summary. A feature kept outside
`featuresDir` and listed in `additionalFeatureDirs` still counts for the
steps it binds, so `pattern-unbound` and `fixture-unused` do not report
its steps as dead, but nothing runs it unattended.
