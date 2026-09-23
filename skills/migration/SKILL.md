---
name: migration
description: Use when moving an existing test suite onto nukadoko, whether from cucumber-js (typically driving Playwright), from a Playwright Test suite with no cucumber and no Gherkin, or from another DSL already shaped as typed steps. Covers the two-stage discipline that keeps every failure traceable to one change, the `nukadoko/compat` door, sharing an implementation with a Playwright Test suite, and promoting steps to typed `defineStep`s at your own pace.
compatibility: Requires the nuka CLI from the nukadoko npm package on PATH; every step below shells out to it (nuka init, nuka check, nuka run, nuka steps, nuka describe, nuka do, nuka harvest).
license: MIT
---

# Migrating to nukadoko

## What this is for

An existing suite moving onto nukadoko, one piece at a time, not a rewrite.
Open the reference for the suite you actually have, and follow that file.
This one only says which file, and what must stay true on every path.

- **A cucumber-js suite**: feature files plus glue, usually driving
  Playwright. `references/cucumber-js.md` (switch the import, then add
  typing, including the one worked example and a global `After` hook).
- **A Playwright Test suite with no cucumber and no Gherkin yet.** Nothing
  about it moves onto nukadoko; nukadoko grows beside it.
  `references/playwright-test.md`.
- **A suite already shaped as typed steps**: its own DSL, not cucumber's.
  `references/typed-dsl.md`.

If the project is not initialized yet (no `nukadoko.config.ts` or
`nukadoko.config.mts`), run `nuka init` first. An existing suite can be
CommonJS (no `"type": "module"` in `package.json`); `nuka init` writes
`nukadoko.config.mts` there instead, and step files need the same `.mts`
extension.

## Before the first change

This one rewrites a suite that currently works. Before the first change,
say which stage you are in, what it touches, and what it deliberately
leaves alone.

Say plainly that switching the import is reversible: switch it back and
the suite is a plain cucumber-js suite again, which is the promise the
compat door is built to keep. Starting from a Playwright Test suite
instead has a different reversal: delete the feature files and the step
files, and the suite is untouched, because nothing it uses ever imported
nukadoko.

Name the irreversible one when you reach it. Promoting a step to
`defineStep` does not switch back, so it needs a word before the first
one, not after the tenth (see "What not to do").

Keep it short. Predictability is the reassuring part, not volume.

## Two stages, never at once

Change one thing, then the next. Never both at once. If a step breaks
after two changes land together, there is no way to tell which one broke
it. If the stages in the reference for your starting point don't fit,
derive your own two stages from this. What has to hold is the
traceability, not those particular stage names.

`references/cucumber-js.md` is where that split is "switch the import",
then "add typing". The other two references derive their own pair from
the same rule.

## What not to do

- **Don't do Stage 1 and Stage 2 at once.** Mixing an import switch with
  added typing in the same change is exactly the thing that makes a
  failure unattributable (see "Two stages, never at once" above).
- **Don't let the suite stop running while it's partway migrated.** Compat
  and typed steps coexist in the same feature file; a suite with some
  steps promoted and others still compat must keep passing throughout.
  Never make "fully typed" a precondition for "runs."
- **Don't delete compat glue before its typed replacement is written and
  passing.** Write the new step, get it running with `nuka do`, only then
  remove the old one, never the other order.
- **Don't guess at a fix `nuka check` or `nuka run` didn't ask for.** Their
  output is the evidence for what's wrong; changing something they didn't
  flag is a change made on a hunch, not on what actually broke.
