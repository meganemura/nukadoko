Feature: compat step timeout enforcement

  Scenario: a step exceeding its own timeout fails and the scenario moves on
    Given a legacy step that outlives its own timeout
    When the next legacy step runs

  Scenario: a step finishing well within its own timeout succeeds
    Given a legacy step that finishes well within its own timeout
