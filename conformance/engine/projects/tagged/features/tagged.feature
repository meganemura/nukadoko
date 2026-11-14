@suite
Feature: tagged scenarios

  @fast
  Scenario: a fast one
    Then 1 is below 10

  @slow
  Scenario: a slow one
    Then 2 is below 10

  @fast @flaky
  Scenario: a fast flaky one
    Then 3 is below 10

  Scenario Outline: rows tagged by their Examples
    Then <n> is below 10

    @fast
    Examples: fast rows
      | n |
      | 4 |

    @slow
    Examples: slow rows
      | n |
      | 5 |
