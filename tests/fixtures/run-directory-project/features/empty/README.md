This directory exists on disk but holds no `.feature` file -- exercises
`nuka run`'s own directory-target refusal when the walk finds nothing to
run, in the same "name what it looked
at" tone `nuka check`'s own `no-step-files-found`
(tests/fixtures/check-no-step-files-project) already exercises for step
files.
