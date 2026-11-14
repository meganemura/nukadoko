Feature: an After hook that throws

  @after-hook-throws
  Scenario: the scenario record is still written, failed, even though the After hook itself throws
    When a no-op legacy step runs
