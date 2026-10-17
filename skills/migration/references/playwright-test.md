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
imported nukadoko.
