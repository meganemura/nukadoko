Feature: todos counted with an owner some scenarios name

  Scenario: an owner is named
    Given a list of 3 todos
    And an owner "aki"
    When the open todos are counted
    Then the count is 2
    And the owner is "aki"

  Scenario: no owner is named
    Given a list of 2 todos
    When the open todos are counted
    Then the count is 1
    And the owner is "nobody"
