---
name: acceptance
description: Use when turning a requirement into a Gherkin scenario a person approves on a pull request, starting from whatever is on hand, whether that is raw prose with no stated acceptance criteria yet (a ticket, a request, a conversation), acceptance criteria that still need concrete scenarios, a scenario ready to write, a path already explored one `nuka do` call at a time and now worth fixing in a scenario, a browser app whose state cannot be repeated and has to be explored through a Playwright MCP server first, or a model or relation of request-only steps that `nuka experimental explore` should run.
compatibility: Requires the nukadoko npm package installed in the project (a devDependency), whose nuka CLI is run as `npx nuka`; the loop below shells out to it (nuka init, nuka steps, nuka describe, nuka scaffold, nuka do, nuka experimental explore, nuka check, nuka run, nuka tend).
license: MIT
---

# nukadoko acceptance loop

A person approves a change by reading the feature file in the pull
request's diff and the run summary CI posts beside it; approving is the
sign-off. The feature is written before the implementation it judges,
from the criteria and never from the program's output, which is what
makes a green run evidence rather than agreement. This file is the order
of work: open the reference a step names when you reach it.
`node_modules/nukadoko/llms.txt` names every command, flag, and code.

## Before the first command

Say in two or three sentences what the loop is for and what it will
touch, then one line for each of these that applies:

- A `mutates: true` step that reaches past the project (a real service, a
  shared database, a file outside `scratch`) gets a go-ahead before its
  first `nuka do`, once, not on every retry. A step that writes only under
  `scratch`, or only to a server a fixture started for the scenario, needs
  none (`references/writing-steps.md`, "Asking before a step changes
  something").
- A step that needs `page`, `context`, or `request` needs the project's
  own `playwright`; `nuka check` reports `playwright-missing` with the
  install line. Adding it is a dependency change: ask first. A `page` step
  makes `nuka run` open a browser and take minutes.
- A Playwright MCP server, when the loop explores a browser app whose
  state cannot be repeated, drives the real application with whatever
  login it holds. A click that submits something there needs the same
  go-ahead (`references/exploring.md`).

Run-time output lands under `.nukadoko/`, gitignored, and can hold
credentials in plaintext. nukadoko makes no outbound calls of its own and
never commits, pushes, or publishes. Keep the narration short.

## Where to start

Run `nuka` from the directory that holds the config, and `nuka init`
first when there is none (`references/running.md`, "Setting up"). Then
pick the one line that is true:

1. **Prose only** (a ticket, a request, a conversation):
   `references/from-prose.md`, then line 2.
2. **Criteria sentences, no scenario yet**: `references/scenario-rules.md`
   and `references/writing-the-feature.md`, then the loop.
3. **A concrete scenario, or one you can write directly**: the loop.
4. **A path already run** with `nuka do` or a Playwright MCP server:
   write the scenario from what you ran (`references/exploring.md`, "Then
   fix what you found"), then the loop at step 3.
5. **A browser app whose state cannot be repeated** (an account that
   opens once): drive it through the host's Playwright MCP server,
   connected when its `browser_*` tools are listed; a Claude Code host
   adds it with `claude mcp add playwright npx @playwright/mcp@latest`
   once the person agrees. Then line 4 (`references/exploring.md`,
   "Exploring state that cannot be repeated").
6. **A model or a relation over request-only steps**:
   `references/models.md` (`nuka experimental explore`, which can change
   in any release), then the loop at step 3.

If none is true, ask what this is supposed to do before writing anything.

## The loop

1. **Feature first.** Write the `.feature` from the criteria, by
   `references/scenario-rules.md`, and copy the criteria verbatim under
   `Feature:` (`references/writing-the-feature.md`). Every expected value
   is one the criteria state; a value they do not state is a question for
   a person, not a guess and not a value read off the program.
2. **Steps.** `nuka steps` lists the vocabulary and `nuka describe <step>`
   one contract; reuse before scaffolding. `nuka scaffold --feature <file>`
   writes a stub for each undefined line, or one at a time: `nuka scaffold
   <name> --pattern "<line>" --description "<what it does>"`, with
   `--then` for a Then, `--command <entry point>` for a When that runs a
   program, and `--from <step>.<key>` for each value read from an earlier
   step. `--from` needs the producer to return that key already, so
   implement producers first. Run each step alone with `nuka do <step>
   --args '<json>'` (`references/writing-steps.md`, which names the
   references for the file, assertions, parts, and fixtures). Finished
   projects: `references/examples/` (`cli.md`, `http-api.md`,
   `workflow.md`).
3. **`nuka check <feature>`.** Fix every error and read every warning: a
   warning is a question about intent, not noise. Each finding names its
   `file` and a `do:` line; run or apply it (`references/running.md`).
4. **`nuka run <feature>`** until green. A failure names the step, the
   first line of its error, its step record, and a `rerun` line; read the
   record before running again (`references/diagnosing.md`). A red Then is
   fixed in the implementation, or by asking the person; it is never
   fixed by weakening the Then until it matches the output.
5. **Commit before the run you report**, push, and open the pull
   request; CI posts the run summary (`docs/ci.md` in the package).
6. **Decide where the feature lives**, in the same pull request: the
   product's core path moves into `featuresDir`, which `nuka run` runs on
   every commit; a feature for one change stays outside it, named in
   `additionalFeatureDirs` (`references/maintenance.md`).

A lesson from a run becomes an example row, then a rule, then a finding
code (`references/scenario-rules.md`, "How this file grows").

## What not to do

- Don't write a Then from what the program printed, and don't edit a Then
  after a red run without the person's word. Either is the implementation
  grading itself.
- Don't fill in a requirement the source never stated
  (`references/from-prose.md`).
- Don't run a step that reaches past the project without a go-ahead, and
  don't keep fixing one step past three cycles: report where it stands. A
  prompt that gives a different budget overrides the three.
- Don't hand-edit a step record or a run summary: it was measured, and
  editing it turns it back into a claim.
- Don't change a model or a relation only to make a failure that `nuka
  experimental explore` printed go away (`references/models.md`).
- Don't run `nuka tend` on every pull request, or act on its notes
  unasked: report them (`references/maintenance.md`).
