Feature: Undefined step

  Scenario: references an unknown step
    Given a thing "widget" exists
    Then this text matches no step definition at all
