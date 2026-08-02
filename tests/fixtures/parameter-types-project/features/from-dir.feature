Feature: Listing items with an optional location clause

  Scenario: list items with no location clause
    Given the items are listed

  Scenario: list items with a location clause
    Given the items are listed from 'inventory'
