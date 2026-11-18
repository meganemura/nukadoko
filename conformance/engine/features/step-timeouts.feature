Feature: a step that takes too long fails as timed out

  A step's timeout bounds its own run, and without one the config's stepTimeout does.
  The error names which of the two fired, so the reader knows which one to raise.

  Scenario: each deadline fails its step and names itself
    Given the project "timeouts"
    When nuka runs "run --json"
    Then it exits with 1
    And the run.json at "scenarios[0].steps[0].status" is
      """
      "passed"
      """
    And the run.json at "scenarios[1].steps[0].error.kind" is
      """
      "timeout"
      """
    And the run.json at "scenarios[2].steps[0].error" is
      """
      {
        "kind": "timeout",
        "message": "Step \"brief-wait\" timed out after 100ms (the step's own timeout)"
      }
      """

  Scenario: nuka steps shows a step's own timeout
    Given the project "timeouts"
    When nuka runs "steps --json"
    Then the envelope at "steps[0].timeout" is
      """
      100
      """
