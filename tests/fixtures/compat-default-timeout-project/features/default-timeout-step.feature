Feature: setDefaultTimeout applies to a step with no own timeout

  Scenario: fails around the default timeout, not the sleep duration
    Given a legacy step with no own timeout that sleeps a while
