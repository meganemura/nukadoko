---
name: acceptance
description: Use when turning a requirement into a Gherkin scenario a person approves on a pull request, starting from whatever is on hand, whether that is raw prose with no stated acceptance criteria yet (a ticket, a request, a conversation), acceptance criteria that still need concrete scenarios, a scenario ready to write, a path already explored one `nuka do` call at a time and now worth fixing in a scenario, or a model or relation of request-only steps that `nuka explore` should run.
compatibility: Requires the nuka CLI from the nukadoko npm package on PATH; the loop below shells out to it (nuka init, nuka steps, nuka describe, nuka scaffold, nuka do, nuka harvest, nuka explore, nuka check, nuka run, nuka tend).
license: MIT
---

# nukadoko acceptance loop

## What this is for

A person approves a change by reading two things on its pull request: the
feature file in the diff, and the run summary CI posts beside it. The
summary says that the scenarios ran green at one commit; approving the pull
request is the sign-off. nukadoko writes no separate record of that
approval. Whether the criteria still hold later is a question for the next
CI run, not for the old summary.

This skill is the path from whatever you start with (raw prose, general
acceptance criteria, a scenario ready to write, or a path already
explored one `nuka do` call at a time) through that pull request and the
placement decision that goes with it. Open the reference named on a step
before doing that step. This file is the order, not the procedure.

## Before the first command

The person watching has not decided to trust this tool yet. Before the
first command, say in two or three sentences what the loop is for and
what it will touch. After that, name anything that costs time, changes
state, or outlives the command, one line each:

- **`nuka do` on a `mutates: true` step** changes real state. That one
  needs a go-ahead before the first run of that step, not a mention
  afterwards, and not again on every retry
  (`references/writing-steps.md`).
- **A step that needs `page`** makes `nuka run` open a browser and take
  minutes. Say so before the first run that includes one. Steps built on
  `runCommand` or `request` open no browser.
- **`nuka session start`**, once the loop reaches it, leaves a process
  holding a browser and live credentials. Say `nuka session stop <name>`
  with it. `--idle-timeout` sets how long it waits, in seconds (900 when
  omitted). A value the process cannot keep is refused before it starts
  (`references/exploring.md`).

nukadoko itself makes no outbound network calls. What leaves the machine
is what your own steps send to the application you pointed them at.
Everything written at run time lands under `.nukadoko/`, gitignored by
`nuka init`, holding live credentials in plaintext. Nothing here commits,
pushes, or publishes on its own. Keep the narration short: a paragraph
before every command is its own way of being hard to follow.

## Where to start

If the project is not initialized, run `nuka init` first. It writes the
config, `features/steps/`, a `.gitignore` entry, and a `test:scenarios`
script in `package.json`, so `npm run test:scenarios` runs `nuka check`
and then `nuka run features`. If it prints a `tsconfig.json` line, add the
entries it names. Add `--allure` only when someone reads Allure reports,
and `--env` when the project keeps `.env` files; both report emitters are
off until their config key (`allure: {}`, `messages: {}`) is present. A
CommonJS project (no `"type": "module"` in `package.json`) gets
`nukadoko.config.mts`, and step files need `.mts` too. A hand-written
`nukadoko.config.ts` there fails to import, and the error names the file.

A flag that takes one string or one number is refused when it is given
more than once, and the command writes nothing. `--use` and `--fail-on`
are the repeatable flags. Each value is kept, in the order given.

For a draft from an exploration, run `nuka harvest <step-record-id>...`.
If it refuses the selection, use stderr to correct the ids before saving the draft.

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
   scenario: `references/exploring.md`, then join the loop at step 3
   (`nuka check`).
5. **You want sequences generated against a model, or two runs compared
   by a relation**, with request-only steps: `references/models.md`
   (`nuka explore`), then paste what it prints and join the loop at
   step 3.

If none of the five is true, ask what this is supposed to do before
writing anything. A scenario started without knowing what it proves
proves the wrong thing.

## The loop

The everyday loop is four things: a step per kind of line (`defineStep`),
a `.feature` file, `nuka check`, and `nuka run`. Steps 1 to 4 below are
those four; the rest carries the result to a person.

1. **Steps.** Read the vocabulary: `nuka steps --json`, then
   `nuka describe <step>` for anything that looks relevant. When an
   operation is missing: `nuka scaffold <name> --pattern "<line>"`
   (`--then` for a Then step), implement it, exercise it alone with
   `nuka do`. `references/writing-steps.md` ("Reading the vocabulary",
   "When the vocabulary has no step for it"). The same file: chaining
   (`from`, "Chaining a value from an earlier step"), helper vs part vs
   step ("Helper, part, or step?"), a second scenario that needs part of
   a step ("Splitting a step a second scenario needs half of",
   "Generalizing a step that is too concrete"). A step that runs a
   program uses `runCommand`, in a directory from the builtin `scratch`
   fixture.
2. **Feature.** `references/writing-the-feature.md`. The same criteria
   can live in a Markdown oath instead of a `.feature` file: name it in
   `oaths`, or pass the `.md` path to `nuka check` and `nuka run`. A
   sentence no pattern matches is `undefined-step`. A named directory is
   read for `*.md` files only; one with none (`.MD` does not count) is
   `feature-parse-error`. The grammar is in docs/spec.md ("Markdown
   oaths"). A resource the scenario borrows, a temporary directory
   (`scratch`), a wait for an effect that lands elsewhere (`poll`, whose
   `timeout` is a budget for the whole call), or a required environment
   variable: `references/fixtures.md`. `nuka check` reports
   `fixture-structural-violation` for a config fixture whose
   destructuring cannot be read, and that finding names the fixture.
   Application-specific evidence: `references/evidence.md`.
3. **`nuka check <feature>`.** `references/running.md`. A schema that
   coerces the capture is not `capture-type-mismatch`
   (`references/writing-steps.md`). Compat glue that declares a done()
   callback is `done-callback-arity`.
4. **`nuka run <feature>`** until green. `references/running.md`. When it
   fails, stderr names the failed step's error, its step record path, and
   a `rerun` command per failed scenario. Diagnose from that step record
   before repeating the run: `references/diagnosing.md`. A compat World
   that throws while it is constructed fails that scenario only: stderr
   gets one setup line, later scenarios still run, and the messages
   export is finalized. There is no step record for that failure. `run`
   needs a target; `check` walks the project when given none. Every run
   also writes a Markdown run summary for the reviewer (`--summary
   <path>` for a copy a CI step posts on the pull request). The summary
   states whether the tree had uncommitted changes, so commit before the
   run you report. `npm run test:scenarios` (written by `nuka init`)
   runs steps 3 and 4 for the whole project.
5. Push the feature and its steps, and open the pull request. CI runs
   the feature and posts the run summary on it (`docs/ci.md` in the
   nukadoko package). A person reads the feature in the diff and the
   summary beside it; approving the pull request is the sign-off.
6. Run `nuka tend` once while reporting the pull request, then stop.
   `references/maintenance.md`.
7. Decide where the feature belongs. See "What not to do".

## What not to do

- **Decide where the feature belongs, in the same pull request.** A feature
  describing the change stays outside `featuresDir`: name its directory
  in `additionalFeatureDirs` in `nukadoko.config.ts` so `nuka check` and
  `nuka tend` still see the steps it binds, instead of reporting them
  unbound, without it ever running unattended. If you can't touch the
  config, pass the feature path to `nuka check` instead
  (`references/running.md`). A feature describing the product's own core
  path moves into `featuresDir` instead, so `nuka run` picks it up on
  every future commit; `references/maintenance.md` says what changes on
  `nuka tend` once it does.
- A `.feature` file inside `node_modules`, or inside a directory whose
  name starts with `.`, is outside the walk. `nuka check`, `nuka tend`,
  and `nuka run` do not see it, and the skip reports nothing
  (`references/running.md`).
- Don't fill in a requirement the source never stated. A missing slot is
  a question for a person, never a guessed value
  (`references/from-prose.md`).
- Don't run a `mutates: true` step the first time without a go-ahead, and
  don't keep fixing the same step past three cycles. Report where it
  stands (`references/writing-steps.md`). A prompt that asks for a
  different amount of patience overrides the three; it is not a config
  setting.
- Don't change a model or a relation only to make a failure `nuka explore`
  printed go away. A person reads the printed scenario first
  (`references/models.md`).
- Don't hand-edit a step record or a run summary. It exists because it was
  measured, not claimed; editing it by hand turns it back into a claim.
  A failed run that a later run fixed is history the pull request can
  show, not something to hide.
