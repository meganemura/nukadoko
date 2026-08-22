# Writing the feature

If you can reach the tracker at all (an MCP server, `gh issue view`, a Jira
CLI, or just the ticket pasted into the prompt), carry across its id, URL,
title, and acceptance criteria in the reviewer's own words, unparaphrased.
How you reached it doesn't matter and isn't worth recording; that the
record can be traced back to what it accepted does.

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
project already uses (`@PROJ-123`, `@issue-456`): Gherkin tags cannot
contain `#`, so a bare issue number needs a prefix.

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
verdict because they happened to share a scenario.

## Choosing Given, When, or Then

Pick the keyword for what the line does for its reader. Given is what is
already true, When is the action under test, Then is what has to be
observable afterwards. Matching does not depend on the keyword at all: a
line binds by its pattern alone, so the keyword is a claim to the reader
rather than an instruction to the tool.

The one place the keyword meets a step's contract is `mutates`. A step
declaring `mutates: true` bound in Then position is a `nuka check`
**warning**, not an error, and warnings do not fail `check`. That is
deliberate: a Then line that changes state is usually a Then doing the
When's job, and occasionally it is legitimate, so the tool draws a
person's attention instead of deciding.

`And` and `But` take the position of the primary keyword above them,
which is gherkin's own rule rather than a nukadoko choice, so an `And`
under `Then` sits in Then position too. A `*` line has no position and is
held to none of this.
