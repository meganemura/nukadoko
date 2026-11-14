Feature: World declared keys

  Scenario: a valid declared write passes and is measured
    Then the declared listing is set to "abc123"
    Then the declared listing reads back "abc123"

  Scenario: an invalid declared write fails the step and is not recorded
    Then the declared listing is set invalidly
