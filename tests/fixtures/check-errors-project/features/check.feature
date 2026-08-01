Feature: Errors coverage

  Scenario: ambiguous match
    Given duplicate text "x"

  Scenario: table attached leaves the wrong number of unconsumed keys
    Given a table thing "a"
      | col1 | col2 |
      | 1    | 2    |

  Scenario: undefined step
    Given this step matches no known pattern at all
