Feature: Shopping list in the browser

  Scenario: An item added on the page shows in the list
    Given the shopping list is open
    When "Milk" is added on the page
    Then the list on the page includes "Milk"

  Scenario: The list starts with the items added before
    Given the shopping list is open
    When "Bread" is added on the page
    Then the list on the page includes "Milk"
    And the list on the page includes "Bread"
