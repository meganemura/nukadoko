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
