Feature: a Before hook's own timeout overrides setDefaultTimeout

  @hook-own-timeout
  Scenario: passes because its own (larger) timeout wins over the small default
    When a no-op legacy step runs
