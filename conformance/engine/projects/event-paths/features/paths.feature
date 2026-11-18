Feature: paths two environments compare

  Scenario: adding an item
    When an item is added
    Then the add wrote 1 item

  Scenario: peeking at the items
    When the items are peeked
    And an item is listed
    Then the list was requested 1 time

  Scenario: listing the items
    When an item is listed
    Then the list was requested 1 time

  Scenario: mailing the items
    When the items are mailed
    And an item is listed
    Then the list was requested 1 time

  Scenario: placing an order
    When an order is placed
    And an item is listed
    Then the list was requested 1 time
