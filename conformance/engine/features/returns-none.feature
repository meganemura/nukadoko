Feature: a step with no returns keeps nothing, and refuses a key it would lose

  A step that declares no returns returns nothing.
  A key it gives back would be dropped from the step record, so the step fails and says which.

  Scenario: a step with no returns that gives back nothing passes
    Given the project "returns-none"
    When nuka runs 'do end-on-a-call --args {}'
    Then it exits with 0
    And the envelope at "result" is
      """
      {}
      """

  Scenario: a step with no returns that gives back a key fails and names it
    Given the project "returns-none"
    When nuka runs 'do keep-a-key --args {}'
    Then it exits with 1
    And the envelope at "error.message" is
      """
      "returns validation failed: this step declares no returns, so extra would be dropped from the step record; declare returns with that key, or stop returning it"
      """
