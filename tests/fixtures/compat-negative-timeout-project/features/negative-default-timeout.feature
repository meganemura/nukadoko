Feature: setDefaultTimeout(-1) means no timeout

  Scenario: a step with no own timeout finishes
    Given a legacy step under a negative default timeout sleeps briefly
