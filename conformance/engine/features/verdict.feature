Feature: nuka verdict says whether the newest run judged this working tree

  It reads the newest run that ended and never starts one.
  It passes only when that run recorded this exact working tree, ran whole files, and left nothing red.
  A red run's own failed findings are relayed only when it judged this tree.

  Scenario: no run has ended
    Given the project "tagged" in a git repository
    When nuka runs "verdict --json"
    Then it exits with 1
    And the findings are "run-missing"
    And the verdict judged "missing"

  Scenario: a green run of every file judged this tree
    Given the project "tagged" in a git repository
    When nuka runs "run --json"
    And nuka runs "verdict --json"
    Then it exits with 0
    And the findings are "run-without-base"
    And the verdict judged "judged"

  Scenario: an edit after the run makes it stale
    Given the project "tagged" in a git repository
    When nuka runs "run --json"
    And a line is added to "features/other.feature"
    And nuka runs "verdict --json"
    Then it exits with 1
    And the findings are "run-stale"
    And the verdict judged "stale"

  Scenario: a run of one line judged only part of the files it named
    Given the project "tagged" in a git repository
    When nuka runs "run features/tagged.feature:5 --json"
    And nuka runs "verdict --json"
    Then it exits with 1
    And the findings are "run-partial run-without-base"

  Scenario: a red run's failed findings are relayed
    Given the project "chain" in a git repository
    When nuka runs "run features/chain.feature --json"
    And nuka runs "verdict --json"
    Then it exits with 1
    And the findings are "scenario-failed run-without-base"
    And the verdict judged "judged"

  Scenario: outside git the verdict is the run's own
    Given the project "tagged"
    When nuka runs "run --json"
    And nuka runs "verdict --json"
    Then it exits with 0
    And the findings are "working-tree-unknown run-without-base"
    And the verdict judged "unknown"
