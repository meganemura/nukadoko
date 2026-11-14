Feature: setDefaultTimeout applies to a Before hook with no own timeout

  @hook-default-timeout
  Scenario: fails because the Before hook has no own timeout
    When a no-op legacy step runs
