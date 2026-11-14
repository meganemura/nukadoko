Feature: compat step pending/skipped returns are not interpreted

  Scenario: a step returning "pending" fails
    When a legacy step returns pending

  Scenario: a step returning "skipped" fails
    When a legacy step returns skipped
