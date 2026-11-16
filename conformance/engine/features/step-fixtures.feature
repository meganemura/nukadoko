Feature: a step's section, poll, evidence, and resultOf fixtures

  A step body marks the stages it reached with section, waits for a state with poll, keeps a file only it can make with evidence, and reads an earlier step's result with resultOf.
  A Ruby step names resultOf as result_of, which reaches the same fixture.

  Scenario: a step waits for an earlier result and keeps it
    Given the project "step-fixtures"
    When nuka runs "run"
    Then it exits with 0

  Scenario: two people in one scenario each get a browser context of their own
    pageAs gives each name a context of its own; a later call for the name gets the same page, and one with other options is refused.
    A Ruby step names pageAs as page_as, which reaches the same fixture.

    Given the project "page-as"
    When nuka runs "run"
    Then it exits with 0
