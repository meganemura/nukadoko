Feature: a positive step timeout still applies when the default is negative

  Scenario: fails at the step's own timeout, not after the sleep
    Given a legacy step whose own timeout is short sleeps too long
