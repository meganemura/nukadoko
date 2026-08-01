Feature: Table binding

  Scenario: a table binds successfully
    Given a table thing "a" exists
      | col1 | col2 |
      | x    | y    |

  Scenario: a table fails to bind
    Given a bad table thing "a" exists
      | col1 | col2 |
      | x    | y    |
