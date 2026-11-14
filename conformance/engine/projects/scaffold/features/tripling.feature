Feature: lines no step matches yet

  Scenario: tripling
    Given I double 3
    When I triple 4 apples named "red"
    And a list is posted
      | a | b |
    Then the total is 12
    And nothing is left
    And it works
    And the note reads
      """
      hi
      """
