Feature: arrivals

  Scenario: the row arrives after the claim read
    When a slow item is added
    Then 1 slow rows were written

  Scenario: the program keeps writing
    When a moment passes
    And an item is added
    Then 1 rows were written to "items"
