Feature: more lines nuka check reads as mistakes

  Scenario: a value no earlier line returned
    Then the doubled number is below 10

  Scenario: a value two earlier lines returned
    When I double 3
    And I double 4
    Then the doubled number is below 10

  Scenario: a from key every line fills
    When I double 3
    And I halve the number 6
    Then the doubled number is below 10

  Scenario: a table with two keys left to fill
    When I list these
      | a |
    Then the doubled number is below 10

  @with:search @without:search
  Scenario: conditions no environment meets
    When I double 3
    Then the doubled number is below 10

  Scenario Outline: an outline with no rows
    When I double <n>
    Then the doubled number is below 10

    Examples:
      | n |
