Feature: a cucumber suite comes in through the compat door

  Each engine loads step definitions written for its own cucumber (cucumber-js, cucumber-ruby) as they are.
  A compat step is named by its pattern, has no contract, and runs with a step record of its own; its hooks run on the scenario's World and are listed in the scenario record.
  A compat step in Then position judges by failing or not, so nuka check warns of it and run.json says the scenario was judged by compat.

  Scenario: check warns of each compat step in Then position
    Given the project "compat"
    When nuka runs "check --json"
    Then it exits with 0
    And the findings are "scenario-without-then then-compat-step scenario-without-then then-compat-step scenario-without-then then-compat-step scenario-without-then"

  Scenario: the vocabulary lists compat steps by their patterns
    Given the project "compat"
    When nuka runs "steps --json"
    Then it exits with 0
    And the envelope at "steps[0]" is
      """
      {
        "file": "features/steps/basket.*",
        "kind": "compat",
        "name": "compat: an empty basket",
        "patterns": [
          "an empty basket"
        ]
      }
      """

  Scenario: nuka do refuses a compat step
    Given the project "compat"
    When nuka runs "do 'compat: an empty basket'"
    Then it stops with "compat-step-not-runnable"

  Scenario: a run records each compat step and hook
    Given the project "compat"
    When nuka runs "run --json"
    Then it exits with 1
    And the run lists these scenarios
      """
      features/basket.feature:3 default passed
      features/basket.feature:11 default failed
      features/basket.feature:17 default passed
      features/basket.feature:21 default failed
      """
    And the run.json at "scenarios[0].judged_by" is
      """
      "compat"
      """
    And the run.json at "scenarios[0].steps[1].mutates" is
      """
      null
      """
    And the run.json at "scenarios[0].hooks" is
      """
      [
        {
          "status": "passed",
          "type": "before"
        },
        {
          "status": "passed",
          "type": "after"
        }
      ]
      """
    And the run.json at "scenarios[1].steps[2].error.kind" is
      """
      "step_error"
      """
    And the run.json at "scenarios[2].hooks" is
      """
      [
        {
          "status": "passed",
          "type": "before"
        },
        {
          "status": "passed",
          "type": "before"
        },
        {
          "status": "passed",
          "type": "after"
        }
      ]
      """
    And the run.json at "scenarios[3].steps[1].error.kind" is
      """
      "unsupported"
      """
    And the run.json at "scenarios[3].judged_by" is
      """
      "nothing"
      """
