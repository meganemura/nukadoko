Feature: Malformed feature file

  Scenario: mismatched table cell count
    Given a table thing "a"
      | col1 | col2 |
      | 1    |
