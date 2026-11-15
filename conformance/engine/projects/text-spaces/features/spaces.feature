Feature: spaces

  Scenario: a view trims the spaces JavaScript's trim takes
    Then the text "x\u00a0" reads as "x"
    And the text "x\u3000\ufeff\u2028" reads as "x"
    And the list "a\u00a0,\u00a0b" reads as '["a","b"]'
    And the list "\u00a0" reads as '[]'
    And the list "a, b," reads as '["a","b",""]'

  Scenario: a NUL is no space to trim
    Then the text "x\u0000" reads as "x"

  Scenario: a comma at the end leaves an empty item
    Then the list "a,b," reads as '["a","b"]'
