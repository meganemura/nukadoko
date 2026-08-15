Feature: a scenario outline whose rows share a name

  # The row-label column is never referenced by any step's own text below,
  # on purpose: both rows' own pickle steps read identically ("a row that
  # always passes"), so the two rows share not just a name but the exact
  # same interpolated step text too. The only thing that can tell them
  # apart is the Examples table value itself -- exactly the failure mode
  # selftest-suite/features/same-scenario-across-runs.feature's own third
  # scenario pins, isolated from any other signal that might paper over it.
  Scenario Outline: the tracked outline scenario
    Then a row that always passes

    Examples:
      | label |
      | one   |
      | two   |
