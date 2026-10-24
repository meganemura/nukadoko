# Writing the feature

If you can reach the tracker at all (an MCP server, `gh issue view`, a Jira
CLI, or just the ticket pasted into the prompt), carry across its id, URL,
title, and acceptance criteria in the reviewer's own words, unparaphrased.
How you reached it doesn't matter and isn't worth recording; that the
feature can be traced back to what it was written for does.

nukadoko has no concept of a ticket, so the feature file is the only place
that link is recorded, and the reviewer reads it in the pull request's diff
next to the run summary. Don't write a field you couldn't fill: an
empty `Ticket:` line is worse than no line at all, because it reads as a
link that was lost rather than one that was never available.

Each scenario is those criteria translated into the vocabulary
(`references/writing-steps.md`, "Reading the vocabulary"), whether they
arrived straight from a ticket or through the requirements stage below.
Where that translation is a judgment call, the judgment is what review of
the feature is for. `scenario-rules.md` is what makes a scenario able to
fail for the right reason: a Then that claims a value, an expected value
taken from the criteria, a sentence that names what a user sees.

```gherkin
@PROJ-123
Feature: Sign in with valid credentials

  Ticket: https://example.atlassian.net/browse/PROJ-123
  Title: A user can sign in with a correct email and password

  Acceptance criteria (verbatim from the ticket):
  - Signing in with a correct email and password lands on the dashboard
  - A wrong password shows an error and does not sign the user in

  Scenario: ...
```

The tag carries the id in a form something can grep for; the free text
under `Feature:` carries what a person needs. Follow whatever tag shape the
project already uses (`@PROJ-123`, `@issue-456`). A bare `@#456` parses
as a tag, but `#` reads as a comment to most readers and tools, so give
an issue number a prefix.

With no tracker to carry across, drop the tag and the `Ticket:` line and
keep the free text. That block is the place for anything a reader needs
that no line of the scenario establishes, a premise the scenario takes as
already true included. Do not turn such a premise into a step unless the
scenario really does establish it: a step is a claim that something ran.

## From requirements to scenarios

This is where information gets added that no requirement sentence stated:
concrete values, boundaries, negative paths. Turning "a discount code
applies to eligible orders" into a scenario means picking an actual code,
an actual order total, and an actual eligibility rule to test against, and
none of those came from the requirement itself. This is real information,
not implied by the requirement, so it has to be visible, not silently
assumed.

- **Surface every assumption.** State beside the scenario what was chosen
  and why (a comment, a linked table, or the PR description), rather than
  leaving a literal value to speak for itself. A reviewer who can't see
  what was assumed can't tell whether it was the right assumption.
- **Keep the trace.** Which requirement sentence produced which scenario
  should be readable later, not just at the moment of writing. The
  ticket-verbatim convention under `Feature:` (see above) already carries
  this for a scenario sourced from a ticket; keep the same discipline for
  one whose trace target is a requirement sentence rather than a ticket.
- **Know when a single scenario stops being the right tool.** A rule with
  several combining conditions doesn't resolve sentence by sentence; reach
  for a decision table or a state model instead of writing one scenario
  per case and hoping the combinations stay covered. What decides whether
  to reach for one is the number of conditions the rule combines, not how
  large the project is: a two-person tool with one four-condition rule
  needs the table as much as a large one does.

A model drafting this translation is not the problem this stage guards
against; drafting is fine, and it can happen before any of it is fixed.
What gets fixed is the moment a person reads the draft, sees the
assumptions it made, and accepts them: that happens before any
implementation is generated from the scenario, which is the whole point of
doing it here rather than after. What the stage forbids is a draft whose
assumptions never surface at all, not the act of drafting one.

## Scenario Outline and Background

Gherkin compiles a feature into pickles before nukadoko ever runs it: a
Scenario Outline's `Examples` table produces one independent pickle per
row, never one pickle covering the whole table, and a Background's own
steps are folded into every pickle in that feature, run ahead of that
scenario's steps. Writing an Outline row per case, rather than one
scenario asserting several values in a row, is what keeps each case its
own step records and its own pass or fail, never two cases sharing one
verdict because they happened to share a scenario. Put a column in the
Outline's name (`Scenario Outline: greets <name>`): with several rows and
no column there, every row has the same name in the run summary, and
`nuka check` warns `outline-rows-share-name`. Use an Outline when the
rows differ only in values and share every sentence, and separate
scenarios when a row needs a sentence of its own. A Background holds a
Given that every scenario of the file shares, and nothing else.

## Choosing Given, When, or Then

Pick the keyword for what the line does for its reader. Given is what is
already true, When is the action under test, Then is what has to be
observable afterwards. Matching does not depend on the keyword at all: a
line binds by its pattern alone, so the keyword is a claim to the reader
rather than an instruction to the tool. The same step can be the When of
one scenario and a Given of another: a registration is the action under
test in "a short password" and the setup in "sign in before confirming".
A step that can be refused returns the outcome instead of throwing, so a
Then can claim the refusal (`examples/workflow.md`).

The keyword meets a step's contract in one place: a Then binds a claim
step, and only a Then does. A Then bound to a step that runs is the
`then-without-claims` error, and a claim step in Given or When position
the `claims-outside-then` error. A Then line that acts is a Then doing
the When's job, and a Given that judges would make a broken setup read as
a failed criterion.

`And` and `But` take the position of the primary keyword above them,
which is gherkin's own rule rather than a nukadoko choice, so an `And`
under `Then` sits in Then position too. A `*` line has no position and is
held to none of this. A scenario with a Given or a When of its own and
no Then, in it or in the Background, passes whenever its steps run, so
`nuka check` warns `scenario-without-then`. Add the Then line that names
what the reader must observe afterwards; a step that checks something
but sits under Given or When belongs under Then instead.
