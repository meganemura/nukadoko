Feature: setDefaultTimeout(-1) means no timeout for a Before hook

  @hook-negative-default
  Scenario: a Before hook with no own timeout finishes
    When a no-op legacy step runs under a negative default
