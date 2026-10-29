# Writing a scenario that can be wrong

The criteria are fixed before the implementation exists, so a scenario is
evidence only if nothing in it came from the implementation. Each rule
below says what to write, shows the weak form and the strong form, and
names the finding that enforces it, or says `review` when no check can
decide it without guessing. `examples/` beside this file holds three
finished projects (`cli.md`, `http-api.md`, `workflow.md`) that follow
every rule, with the output of real runs.

## S1. A Then claims a value, not a verdict

Bad: `Then the command succeeds`, `Then the output contains "food"`.
Good: `Then it exits with 0`, then `And the output is` with the exact
lines in a docstring. The step declares claims, and each expected value
is a key the sentence fills or a literal its fixed words state:
`defineStep` refuses `{ literal: 0 }` under "the command succeeds", and
`Then the list is empty` may claim `[]`.
Checked by: `then-without-claims` for a Then bound to a step that runs,
and `claim-compares-itself` for a claim whose two sides are one value;
whether the sentence says enough is review.

## S2. Every scenario has a Then, after the When

Bad: a scenario of a Given and a When. It runs green and gates nothing.
Good: at least one Then line, last.
Checked by: `scenario-without-then` for a scenario with no Then line,
one of only `*` lines, or one whose Then lines bind no claim step;
`from-order-violation` for a Then that reads a step placed after it, and
`events-producer-missing` for one that counts that step's execution events.

## S3. Expected values come from the criteria, never from a run

Bad: run the program, paste what it printed into the docstring, run green.
Good: the docstring holds the example the criteria gave. When the criteria
give none, write the question beside the scenario and stop. When the run
is red, the implementation or the criteria are wrong; the docstring is not
edited to match without the person's word.
Checked by: review, and the loop's order: the feature is written before
the first `nuka run`.

## S4. The sentence names what a user sees

Bad: `Then the users Map has one entry with confirmed = true`.
Good: `Then the sign-in is accepted`.
Bad: `When the POST handler is called with {"name":"lamp"}`.
Good: `When I POST this body to /items`, the body in a docstring. The
route is the public surface of an API; a handler, a table, or a Map is
not. The mechanism lives in the step file and can change without the
sentence.
Checked by: review.

## S5. Values live in the sentence, the table, or the docstring

Bad: a step whose `run()` holds `"correct horse"`.
Good: `a registration for {email:string} with password {password:string}
is submitted`. The reviewer sees every value the scenario depends on.
Checked by: `unknown-capture-key` and `unfillable-required-key` keep the
pattern and `args` together; a literal inside `run()` is review.

## S6. A negative path is its own scenario and claims the exact refusal

Bad: `Then the registration fails`.
Good: `Then the registration is refused because "email already
registered"`. The When step returns the outcome (`outcome: "refused"`,
`reason`) and does not throw on a refusal, so the Then claims both
through `from`.
Checked by: review.

## S7. Each Outline row is told apart by its name

Bad: `Scenario Outline: a bad request body` over three rows: the run
summary lists the same name three times.
Good: `Scenario Outline: a bad request body: <body> answers <status>`;
the run prints `a bad request body: {} answers 422`.
Checked by: `outline-rows-share-name`.

## S8. A scenario starts from nothing it did not establish

Bad: scenario 2 reads the item scenario 1 created. The server
`nukadoko.program.ts` starts serves every scenario of the run, as a
fixture with `scope: "process"` does. Measured in `examples/http-api.md`:
the read got `{"id":2,"name":"lamp"}` where the feature expected id 1.
Good: `Given an item named "lamp" exists` in the scenario that reads it,
and claims on what the scenario created (the body the Given returned),
never on everything the server holds. A fixture that holds state is
scoped per scenario; `scope: "process"` is for a resource no scenario
writes to, or one each scenario resets.
Checked by: review. `repeated-scenario-prefix` names a process-scope
fixture only when every shared step declares `mutates: false`; for any
other opening it names the step that may write.

## S9. One action per scenario, one claim per Then line

Bad: `Then it exits with 0 and prints "food: 5.5"`.
Good: `Then it exits with 0` and `And the output is` on two lines: two
step records, two failure messages, two things a reviewer can read.
Checked by: review.

## S10. A Given establishes; the When is the action under test

Bad: `Given I run tally with "missing.csv"`, then `Then it exits with 2`.
Good: `Given an empty directory`, `When I run tally with "missing.csv"`.
The same step can be the When of one scenario and a Given of another: a
registration is the action in "a short password" and the setup in "sign
in before confirming". The keyword says which it is in this scenario.
Checked by: `from-order-violation` when the action written as a Given has
no Given before it to read from (`examples/cli.md`),
`claims-outside-then` for a claim step in Given or When position, and
`then-without-claims` for a step that runs in Then position; the rest is
review.

## S11. A failing step says what it saw on its first line

`nuka run` prints the first line of the error beside the failed step; the
rest is in the step record. A Then gets this from its claims: a broken
claim's line names both values and where each came from. Measured in
`examples/cli.md`: `claim broken: "food: 5.5\nrent: 100"
(from:run-tally@16.stdout as text) equal "food: 5.5\nrent: 101"
(sentence:expected); first difference at line 2: actual "rent: 100",
expected "rent: 101"`.
Bad: a Given or a When that throws `new Error("setup failed")`, which
prints nothing it saw.
Good: a message that names what it saw, such as the exit code and the
first line of stderr of the program the Given ran.
Checked by: review.

## S12. The criteria sit under `Feature:`, verbatim, and each scenario proves one

Bad: a feature whose free text paraphrases the ticket, or a scenario no
criterion asks for.
Good: the criteria copied as written under `Feature:`
(`writing-the-feature.md`), and every scenario traceable to one of them.
A scenario no criterion produced is a missing criterion (ask) or not
acceptance (delete).
Checked by: review.

## Shapes that come up

- **A program's input file.** The Given writes it under `scratch.dir()`
  and returns the directory; the When runs the program with that
  directory as `cwd`, read through `from` (`nuka scaffold --command
  --from <given>.dir --cwd dir`). Each `scratch.dir()` call is a new
  directory, so a step that makes its own never sees a file a Given wrote.
- **Arguments.** One `{argv:string}` capture split on whitespace
  (`nuka scaffold --command --argv argv`, no quoting) keeps one When step
  for every flag; one capture per argument keeps the sentence closer to
  prose, and is the shape for an argument that holds a space. Pick one
  per project and keep it.
- **An HTTP API.** `nukadoko.program.ts` starts the server and the steps
  read its URL from `baseURL`. One request step per sentence the reviewer
  reads (`I request that item`, `I request the item list`), each returning
  `status` and `body`; a Then lists every request step in `from`. A slash in a
  pattern is escaped: `I POST this body to \/items`.
- **Outline or scenarios.** An Outline when the rows differ only in values
  and share every sentence; separate scenarios when a row needs its own
  sentence. A Background holds a Given that every scenario of the file
  shares, and nothing else.
- **The same producer twice.** When a step runs twice in one scenario, a
  `from` that names it reads the most recent result.

## How this file grows

A lesson from a real run is promoted in three stages, and each stage
replaces the one before it:

1. **An example row.** Add the decision to the "Decisions" table of the
   example for that kind of project (`examples/<shape>.md`): the date, the
   decision, what was chosen, and why. Add a new example file when no
   existing shape fits.
2. **A rule here.** A decision becomes a rule when it comes up in a second
   example or a second project, or when a red run traced back to its
   absence. A rule has a `Bad:`, a `Good:`, and a `Checked by:` line; the
   test suite refuses a rule without all three.
3. **A finding code.** A rule that `nuka check` can decide
   from the feature file and the step contracts alone, with no guess about
   intent, becomes a code. The rule then names that code on its
   `Checked by:` line, and the code's own `fix:` carries the edit.

This file stays at 200 lines or fewer and `SKILL.md` at 120, both enforced
by a test. When a rule does not fit, remove one: a rule that no example
has cited for two releases, and that no code enforces, is the first to go.
