Feature: What the build wrote

  Scenario: a check writes nothing
    When the build runs with "check"
    Then the build writes nothing
