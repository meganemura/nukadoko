This directory exists on disk but holds no `.feature` file -- exercises
`nuka run`'s own directory-target refusal when the walk finds nothing to run
(run-directory-target task spec, decision 3), the same "name what it looked
at" tone `nuka check`'s own `no-step-files-found`
(tests/fixtures/check-no-step-files-project) already exercises for step
files.
