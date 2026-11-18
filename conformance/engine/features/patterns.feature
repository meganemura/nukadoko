Feature: a step can be bound by more than one wording

  pattern and patterns name the wordings of one step, pattern first.
  Every wording must capture the same keys, so the line that was written never decides what the step receives.

  Scenario: each wording binds the same step
    Given the project "aliases"
    When nuka runs "run"
    Then it exits with 0
    When nuka runs "steps --json"
    Then the envelope at "steps[0].patterns" is
      """
      [
        "I double {n:int}",
        "twice {n:int}"
      ]
      """

  Scenario: wordings that capture different keys are an error
    Given the project "alias-mismatch"
    When nuka runs "check --json"
    Then it exits with 1
    And the check reports
      """
      error alias-key-mismatch features/steps/count.* Step "count" has patterns that bind different key sets: "I count to {n:int}" -> {n}; "I count" -> {}
      warning scenario-without-then features/count.feature:3 Scenario "count" has no Then step, so it passes whenever its steps run without an error, and no step checks an outcome.
      """
