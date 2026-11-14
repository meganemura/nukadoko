Feature: compat hook timeout enforcement

  @hook-timeout
  Scenario: a Before hook exceeding its own timeout fails, skipping this scenario's steps
    Given a no-op legacy step runs
