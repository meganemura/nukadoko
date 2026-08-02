Feature: no setDefaultTimeout call means a step stays unbounded

  Scenario: a step with no own timeout, and no default configured, still passes
    Given a legacy step with no timeout at all runs and takes a little while
