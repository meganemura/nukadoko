Feature: Read-only policy enforcement for nuka run

  Scenario: a declared-mutating step is refused before it runs
    Given a declared mutating step runs
    Then an unreachable step never runs

  Scenario: a step that declares mutates false but actually writes is trusted anyway
    Given a step lying about being read-only runs
