@nukadoko:serial
Feature: a file that runs while no other file runs

  Scenario: a number doubled alone
    When I double 2
    Then the doubled number is below 10
