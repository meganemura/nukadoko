Feature: places

  Scenario: an item is added with quick reorder on
    When the reorder is evaluated "on"
    And an item is added
    Then 1 rows were written to "items"

  Scenario: a peek writes a visit
    When the items are peeked
    And an item is added
    Then 1 rows were written to "items"
