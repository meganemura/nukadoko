Feature: nuka run takes feature files, file:line selections, and directories

  With no target, nuka run runs every feature under the features directory.
  Files run in their path order, compared byte by byte.
  A line selects the scenario whose Scenario line, or whose Examples row, is on it.

  Scenario: no target runs every feature file in path order
    Given the project "tagged"
    When nuka runs "run --json"
    Then it exits with 0
    And the run lists these scenarios
      """
      features/other.feature:3 default passed
      features/tagged.feature:5 default passed
      features/tagged.feature:9 default passed
      features/tagged.feature:13 default passed
      features/tagged.feature:22 default passed
      features/tagged.feature:27 default passed
      """
    And the run's selection is "full"

  Scenario: a line selects one scenario and the run is partial
    Given the project "tagged"
    When nuka runs "run features/tagged.feature:9 --json"
    Then it exits with 0
    And the run lists these scenarios
      """
      features/tagged.feature:9 default passed
      """
    And the run's selection is "partial"

  Scenario: a line on an Examples row selects that row
    Given the project "tagged"
    When nuka runs "run features/tagged.feature:27 --json"
    Then it exits with 0
    And the run lists these scenarios
      """
      features/tagged.feature:27 default passed
      """

  Scenario: a file named twice by two spellings runs once
    Given the project "tagged"
    When nuka runs "run features/./other.feature features/other.feature --json"
    Then it exits with 0
    And the run lists these scenarios
      """
      features/other.feature:3 default passed
      """
    And the run's selection is "full"

  Scenario: a line that is no scenario is refused
    Given the project "tagged"
    When nuka runs "run features/tagged.feature:6 --json"
    Then it exits with 2
    And it stops with "no-scenario-at-line"

  Scenario: a missing feature file is refused
    Given the project "tagged"
    When nuka runs "run features/missing.feature --json"
    Then it exits with 2
    And it stops with "target-not-found"

  Scenario: a line on a directory is refused
    Given the project "tagged"
    When nuka runs "run features:3 --json"
    Then it exits with 2
    And it stops with "line-on-directory"

  Scenario: a Markdown file is refused by name
    Given the project "tagged"
    When nuka runs "run notes.md --json"
    Then it exits with 2
    And it stops with "markdown-target"

  Scenario: a directory with no feature file is refused
    Given the project "tagged"
    When nuka runs "run empty --json"
    Then it exits with 2
    And it stops with "no-feature-files"

  Scenario: an unknown flag is refused
    Given the project "tagged"
    When nuka runs "run --bogus --json"
    Then it exits with 2
    And it stops with "invalid-arguments"

  Scenario: a check error in a selected scenario stops the run before it starts
    Given the project "broken"
    When nuka runs "run --json"
    Then it exits with 2
    And it stops with "check-errors"

  Scenario: a check error in a scenario the run does not select does not stop it
    Given the project "broken"
    When nuka runs "run features/good.feature --json"
    Then it exits with 0
    And the run lists these scenarios
      """
      features/good.feature:3 default passed
      """
