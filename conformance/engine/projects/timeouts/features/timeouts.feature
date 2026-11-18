Feature: a step has a deadline

  Scenario: within the project's deadline
    When it waits 10 ms

  Scenario: past the project's deadline
    When it waits 1500 ms

  Scenario: past the step's own deadline
    When it waits briefly for 1500 ms
