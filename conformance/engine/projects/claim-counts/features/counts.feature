Feature: claims on a count and on what observe read

  Scenario: a count that holds
    When a list is made
    Then the list has 3 items
    And the list is as long as the shown total

  Scenario: a count that breaks
    When a list is made
    Then the list has 4 items

  Scenario: a count of a value that is no list
    When a list is made
    Then the name has 1 items

  Scenario: a shown total that is off
    When a list is made
    Then the list is as long as the shown total plus one
