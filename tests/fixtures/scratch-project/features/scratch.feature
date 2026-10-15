Feature: scratch directories

  Scenario: a scenario that passes
    Given a copy of "seed" is made

  Scenario: a scenario that fails
    Given a copy of "seed" is made
    Then the step fails
