Feature: files that run beside each other

  Scenario: a number doubled beside another
    When I double 3
    Then the doubled number is below 10
