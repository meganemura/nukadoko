Feature: greet

  Scenario: greets by name
    When I run greet with "Ada"
    Then the output says "Hello, Ada!"
