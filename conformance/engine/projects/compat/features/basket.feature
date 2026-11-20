Feature: a basket from a cucumber suite

  Scenario: what goes in is counted
    Given an empty basket
    When I add 3 apples
    And I add these fruits:
      | name | count |
      | pear | 2     |
    Then the basket holds 5 fruits

  Scenario: a count that is off fails the step that judged it
    Given an empty basket
    When I add 1 apples
    Then the basket holds 2 fruits

  @tagged
  Scenario: a tagged hook runs only for its tag
    Given an empty basket
    Then the hook saw the tag

  Scenario: a step not written yet is pending
    Given an empty basket
    When I weigh the basket
