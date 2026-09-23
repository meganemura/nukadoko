# Coming from a Playwright Test suite

If the existing suite has no cucumber and no Gherkin, tests written
directly as `test("...", async ({ page }) => {...})`, the compat door in
`references/cucumber-js.md` does not apply: there is no import to switch.
Nothing here moves onto nukadoko either; nukadoko grows beside the suite
instead.

Nothing is switched this time, so derive two changes from the same rule
as every other starting point: one change, then the next, so a failure
stays traceable to one change. First, pull the operation you want to
reuse out into a plain async function that takes only Playwright's own
objects, in a file neither
runner owns, while the existing suite keeps calling it and stays green.
Second, add a typed `defineStep` whose `run` calls that same function,
declaring `args`/`returns` from the schemas the function's own file
exports. Run `nuka check` and `nuka do <step>` on it the same way you
would for any other typed step; nothing about this starting point changes
what they check or how they run one.

The Playwright suite never imports nukadoko, and a typed step's `run`
never calls the suite's own test function: each side stays a plain caller
of the shared function, never of the other side's runner. Two ways to
blur that boundary are both caught rather than silent: a spec file placed
inside `featuresDir` fails to import (`nuka check`'s
`step-file-import-failed`, carrying Playwright's own refusal message),
and a step file named like a spec collides on pattern with it
(`ambiguous-step`, naming both).

That is what makes this door reversible: delete the feature files and the
step files, and the suite is untouched, because nothing it uses ever
imported nukadoko. `recordStep` is the one exception to keep
in mind on the way out. Calling it directly from inside a spec file, to
turn that suite's own runs into step records `nuka harvest` can draft
from, puts a real `import ... from "nukadoko"` in that spec file, so
removing those call sites is part of the same reversal.

`use` on `recordStep` hides a trap. Pass the previous call's
`stepRecordId` through `use`, not the value it returned. The receiving step
must already declare its own `from` entry naming the upstream step; `use`
only fills it in. Skip `use` and hold that value in a variable instead, and
no chain gets recorded at all. `nuka harvest` then bakes that single run's
value, a cart id, for example, straight into the draft, with no record of
where it came from. `nuka check` stays clean, and `nuka run` goes green,
but that pass proves only that the server remembers one value, not that
the steps chain.
