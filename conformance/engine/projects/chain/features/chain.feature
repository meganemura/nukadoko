Feature: a value one step returns and a later step claims on

  Scenario: the doubled number is below the bound
    When I double 3
    Then the doubled number is below 10

  Scenario: the doubled number is not below the bound
    When I double 6
    Then the doubled number is below 10
