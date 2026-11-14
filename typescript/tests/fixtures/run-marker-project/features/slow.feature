Feature: A run that stays in flight

  Scenario: written before the wait
    Given a visitor named "Ada" arrives

  Scenario: waits for the gate
    Given the gate is open
