Feature: Escape hint coverage

  Scenario: unescaped parens in prose
    Given the amount (USD) is "100"

  Scenario: unrelated undefined step
    Given this text matches nothing at all and has no relation to any pattern
