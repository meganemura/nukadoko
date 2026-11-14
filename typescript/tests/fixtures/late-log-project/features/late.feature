Feature: Lines of the program's log that come after their step

  Scenario: a slow request, then a step that sends nothing
    When the step calls the slow path
    And the step waits

  Scenario: a slow request, then a fast one
    When the step calls the slow path
    And the step calls the fast path
