Feature: hook parameter coverage

  Scenario: a passing scenario
    Given a no-op legacy step runs

  Scenario: a failing scenario
    When a legacy step throws for hook coverage

  Scenario: two passing steps
    Given a no-op legacy step runs
    And a no-op legacy step runs
