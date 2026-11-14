Feature: Listing items with an optional location clause

  Scenario: list items with no location clause
    When the items are listed
    Then the item "item-1" is listed

  Scenario: list items with a location clause
    When the items are listed from 'inventory'
    Then the item "item-in-inventory" is listed
