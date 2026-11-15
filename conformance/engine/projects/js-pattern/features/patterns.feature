Feature: patterns

  Scenario: a pattern means what it means to JavaScript
    Then the text "Ab" matches "\Ab"
    And the text "a\u00a0b" matches "a\sb"
    And the text "x" matches "[^]"
    And the text "ba" matches "(a)|b\1"
    And the text "a{,2}" matches "^a{,2}$"
    And the text "\u00e9" matches "^.$"

  Scenario: a line end is no end of the text
    Then the text "a\u000ab" matches "^b$"

  Scenario: a flag group JavaScript does not know
    Then the text "a" matches "(?i)a"
