Feature: an AfterStep hook that throws

  @afterstep-throws
  Scenario: the step's own status stands, and the rest of the scenario is skipped
    When a no-op legacy step runs
    When a second no-op legacy step runs
