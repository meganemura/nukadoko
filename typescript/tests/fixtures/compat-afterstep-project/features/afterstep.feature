Feature: AfterStep hook coverage

  Scenario: two passing steps
    When a no-op legacy step runs
    When a second no-op legacy step runs

  Scenario: a failing step skips the rest
    When a legacy step throws for afterstep coverage
    When a no-op legacy step runs

  @slow
  Scenario: a tagged scenario
    When a no-op legacy step runs

  Scenario: an untagged scenario
    When a no-op legacy step runs
