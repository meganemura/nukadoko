Feature: Greeting

  Scenario: a first-time visitor is greeted
    When I ask for the greeting
    Then the greeting reads as "friendly to a first-time visitor"

  Scenario: a cart total is shown
    When a cart holds 3 items
    Then the total reads as "a small number"
