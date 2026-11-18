Feature: a fixture's teardown knows how its scope ended

  `use` returns "passed" or "failed" once the scope ends, so a teardown can keep what a failure left for a person to look at.

  Scenario: each scenario's fixture is told whether the scenario passed
    Given the project "fixture-outcome"
    When nuka runs "run"
    Then it exits with 1
    And the project's file "outcomes.txt" is
      """
      passed
      failed
      """

  Scenario: a teardown that raises is a warning, and the scenario keeps its status
    Given the project "fixture-outcome"
    When nuka runs "run"
    Then it exits with 1
    And stderr holds "warning	fixture-teardown-failed	-	fixture \"tenant\" teardown failed: kept the tenant for a look"

  Scenario: the record keeps the teardown error as the fixture raised it
    Given the project "fixture-outcome"
    When nuka runs "run --json"
    Then it exits with 1
    And the envelope at "findings[0].code" is
      """
      "fixture-teardown-failed"
      """
    And the run.json at "scenarios[1].status" is
      """
      "failed"
      """
    And the run.json at "scenarios[1].teardown_errors[0].fixture" is
      """
      "tenant"
      """
    And the run.json at "scenarios[1].teardown_errors[0].message" is
      """
      "kept the tenant\nfor a look"
      """
