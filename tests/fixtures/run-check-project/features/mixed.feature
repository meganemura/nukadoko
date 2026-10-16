Feature: One clean scenario and one with an undefined step

  Scenario: clean
    Given a thing "widget" exists
    Then the thing "widget" is there

  Scenario: undefined
    Given a thing "widget" exists
    Then this line matches no step
