Feature: places a program lists

  Scenario: a peek writes only bookkeeping
    When the reorder is evaluated "on"
    And the items are peeked
    And an item is added
    Then the peek wrote 0 rows
