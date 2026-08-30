Feature: Escape hint coverage

  Scenario: unescaped parens in prose
    Given the amount (USD) is "100"

  Scenario: unrelated undefined step
    Given this text matches nothing at all and has no relation to any pattern

  Scenario: one unquoted string value
    Given the probe is green

  Scenario: one unquoted string value with spaces
    Given the probe state is not

  Scenario: more than one quoted candidate
    Given the ambiguous probe is green

  Scenario: extra text outside the pattern
    Given unrelated the probe is green

  Scenario: escaped literal looks like a parameter token
    Given literal {string} green
