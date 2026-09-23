---
name: acceptance
description: Use when turning a requirement into a signed-off Gherkin scenario, starting from whatever is on hand, whether that is raw prose with no stated acceptance criteria yet (a ticket, a request, a conversation), acceptance criteria that still need concrete scenarios, a scenario ready to write, or a path already explored one `nuka do` call at a time and now worth fixing in a scenario.
compatibility: Requires the nuka CLI from the nukadoko npm package on PATH; the loop below shells out to it (nuka init, nuka steps, nuka describe, nuka scaffold, nuka do, nuka harvest, nuka check, nuka run, nuka accept, nuka tend).
license: MIT
---

# nukadoko acceptance loop

## What this is for

A sign-off records that a scenario ran green at one commit. Signing off
and running the scenario in CI answer different questions: sign-off for
that one commit, CI for whether the criteria still hold today. nukadoko
never re-runs a signed scenario on its own.

This skill is the path from whatever you start with (raw prose, general
acceptance criteria, a scenario ready to write, or a path already
explored one `nuka do` call at a time) through that sign-off and the
placement decision right after it. Open the reference named on a step
before doing that step. This file is the order, not the procedure.

## Before the first command

The person watching has not decided to trust this tool yet. Before the
first command, say in two or three sentences what the loop is for and
what it will touch. After that, name anything that costs time, changes
state, or outlives the command, one line each. Four of those surprise
people:

- **`nuka do` on a `mutates: true` step** changes real state. That one
  needs a go-ahead before the first run of that step, not a mention
  afterwards, and not again on every retry
  (`references/writing-steps.md`).
- **`nuka run`** opens a browser and takes minutes.
- **`nuka session start`** leaves a process holding a browser and live
  credentials. Say `nuka session stop <name>` with it
  (`references/exploring.md`).
- **`nuka accept`** writes a sign-off file meant to be committed. It is
  the only artifact here that claims anything.

nukadoko itself makes no outbound network calls. What leaves the machine
is what your own steps send to the application you pointed them at.
Everything written at run time lands under `.nukadoko/`, gitignored by
`nuka init`, holding live credentials in plaintext. Nothing here commits,
pushes, or publishes on its own. Keep the narration short: a paragraph
before every command is its own way of being hard to follow.

## Where to start

If the project is not initialized, run `nuka init` first. A CommonJS
project (no `"type": "module"` in `package.json`) gets
`nukadoko.config.mts`, and step files need `.mts` too.

1. **All you have is prose** (a ticket, a request, a conversation), nothing
   that reads as a testable statement yet:
   `references/from-prose.md`, then
   `references/writing-the-feature.md`.
2. **You already have general acceptance-criteria sentences** but no
   scenario yet: `references/writing-the-feature.md` ("From requirements
   to scenarios").
3. **You already have, or can write directly, a concrete scenario**: "The
   loop" below.
4. **You already ran the path** with `nuka do` and want it fixed in a
   scenario: `references/exploring.md`, then join the loop at step 4
   (`nuka check`).

If none of the four is true, ask what this is supposed to do before
writing anything. A scenario started without knowing what it proves
proves the wrong thing.

## The loop

1. Read the vocabulary: `nuka steps --json`, then `nuka describe <step>`
   for anything that looks relevant. `references/writing-steps.md`
   ("Reading the vocabulary").
2. When an operation is missing: `nuka scaffold <name>`, implement it,
   exercise it alone with `nuka do`. `references/writing-steps.md`
   ("When the vocabulary has no step for it"). The same file:
   chaining (`from`, "Chaining a value from an earlier step"),
   helper vs part vs step ("Helper, part, or step?"),
   a second scenario that needs part of a step
   ("Splitting a step a second scenario needs half of",
   "Generalizing a step that is too concrete").
3. Write the feature. `references/writing-the-feature.md`. A resource the
   scenario borrows, a wait for an effect that lands elsewhere, or a
   required environment variable: `references/fixtures.md`.
   Application-specific evidence: `references/evidence.md`.
4. `nuka check <feature>`. `references/running.md`.
5. Commit. A run can only be frozen on a clean tree at the commit still
   checked out. Debugging against a dirty tree is fine; it cannot be
   accepted.
6. `nuka run <feature>` until green. `references/running.md`. When it
   fails, diagnose from the failed step's own step record before
   repeating the run: `references/diagnosing.md`. `run` needs a target;
   `check` walks the project when given none.
7. `nuka accept <feature>`, then commit the record it wrote.
   `references/running.md`. A refusal names the condition and the next
   command: `references/diagnosing.md` ("When accept refuses").
8. Run `nuka tend` once while reporting the sign-off, then stop.
   `references/maintenance.md`.
9. Decide where the feature belongs. See "What not to do".

## What not to do

- **Decide where the feature belongs, right after signing off** (`nuka
  accept`'s own stderr asks the same question as a reminder). A feature
  describing the change stays outside `featuresDir`: name its directory
  in `additionalFeatureDirs` in `nukadoko.config.ts` so `nuka check` and
  `nuka tend` still see the steps it binds, instead of reporting them
  unbound, without it ever running unattended. If you can't touch the
  config, pass the feature path to `nuka check` instead
  (`references/running.md`). A feature describing the product's own core
  path moves into `featuresDir` instead, so `nuka run` picks it up on
  every future commit; `references/maintenance.md` says what changes on
  `nuka tend` once it does.
- Don't fill in a requirement the source never stated. A missing slot is
  a question for a person, never a guessed value
  (`references/from-prose.md`).
- Don't run a `mutates: true` step the first time without a go-ahead, and
  don't keep fixing the same step past three cycles. Report where it
  stands (`references/writing-steps.md`). A prompt that asks for a
  different amount of patience overrides the three; it is not a config
  setting.
- Don't hand-edit a written record. It exists because it was measured, not
  claimed; editing it by hand turns it back into a claim.
- Don't delete a record and redo it to get a cleaner one. Its git history
  *is* the acceptance history; a second attempt is a new commit, not a
  replacement.
