Feature: claims a check can judge before the run

  Scenario: claims on what an earlier step returned
    Given an item is made
    Then the item has a colour
    And the item has no secret
    And each tag of the item is a string
    And the item is itself
