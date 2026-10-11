Feature: a step timeout of -1 means no timeout

  Scenario: a step whose own timeout is negative finishes
    Given a legacy step whose own timeout is negative sleeps briefly
