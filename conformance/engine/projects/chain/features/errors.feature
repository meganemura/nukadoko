Feature: a step that fails and the steps after it

  Scenario: the steps after a broken claim are skipped
    When I double 6
    Then the doubled number is below 10
    And the doubled number is below 20

  Scenario: a step that raises stops the scenario before its Then
    When I double 1000
    Then the doubled number is below 10
