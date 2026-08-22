Feature: a check finding names the step's own line

  Scenario: the broken step is not on the Scenario line
    Given a known step runs
    Then this step does not exist at all
