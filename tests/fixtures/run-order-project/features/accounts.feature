Feature: Accounts

  Scenario: nobody has signed up yet
    Then the account count is 0

  Scenario: alice signs up
    When "alice" signs up
    Then the account count is 1
