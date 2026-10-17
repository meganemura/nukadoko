Feature: a step whose from names itself

  Scenario: the step runs once, so nothing earlier fills its cursor
    Then the next page is read

  Scenario: the second read takes the cursor of the first
    Then the next page is read
    And the next page is read
