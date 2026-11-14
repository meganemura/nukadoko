Feature: value

  Scenario: the value stays below a hundred
    Then the value is below 100

  Scenario: the value stays above zero
    Then the value is above 0

  Scenario: the value is not too small
    Then the value is above 1
