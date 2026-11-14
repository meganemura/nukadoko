Feature: compat hook pending/skipped returns are not interpreted

  @hook-pending
  Scenario: a Before hook returning "pending" fails
    Given a no-op legacy step runs
