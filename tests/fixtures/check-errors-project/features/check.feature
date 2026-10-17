Feature: Errors coverage

  Scenario: ambiguous match
    Then duplicate text "x"

  Scenario: table attached leaves the wrong number of unconsumed keys
    Then a table thing "a"
      | col1 | col2 |
      | 1    | 2    |

  Scenario: undefined step
    Then this step matches no known pattern at all
