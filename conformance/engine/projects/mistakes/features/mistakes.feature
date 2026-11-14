Feature: lines nuka check reads as mistakes

  Scenario: a claim step in When position
    When the count is 3
    Then the count is 3

  Scenario: a step that runs in Then position
    When the button is pressed
    Then the button is pressed

  Scenario: a line two steps match
    When I go 3
    Then the count is 3

  Scenario: a capture the args read as another type
    When I wait 3 seconds
    And a step still to describe
    Then the count is 3

  @with:
  Scenario: a condition tag with no condition
    When the button is pressed
    Then the count is 3

  @expects:bogus
  Scenario: an expects tag that reads as nothing
    When the button is pressed
    Then the count is 3

  Scenario Outline: rows that share one name
    When I go <n>
    Then the count is 3

    Examples:
      | n |
      | 1 |
      | 2 |
