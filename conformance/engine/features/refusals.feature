Feature: a refusal says what to change, in the same words in each engine

  A command line nuka run cannot carry out stops before anything runs, with exit 2.
  A selection that keeps no scenario stops with exit 1.
  Either way the finding names a code, says why, and gives a fix, and a do line when one command gets past it.
  Each engine names its own program file, written here as nukadoko.program.*.

  Scenario: a line that is no scenario names the lines that are
    Given the project "tagged"
    When nuka runs "run features/tagged.feature:6 --json"
    Then it exits with 2
    And the stop is
      """
      severity: refused
      code: no-scenario-at-line
      message: No scenario found at features/tagged.feature:6
      fix: Name a line a scenario or an Examples row starts on: 5, 9, 13, 22, 27.
      """

  Scenario: a missing feature file
    Given the project "tagged"
    When nuka runs "run features/missing.feature --json"
    Then it exits with 2
    And the stop is
      """
      severity: refused
      code: target-not-found
      message: Feature file not found: features/missing.feature
      fix: Name a file or a directory that exists.
      do: nuka run --help
      """

  Scenario: a Markdown file
    Given the project "tagged"
    When nuka runs "run notes.md --json"
    Then it exits with 2
    And the stop is
      """
      severity: refused
      code: markdown-target
      message: notes.md is a Markdown file: Markdown oaths were removed, and nukadoko reads scenarios from .feature files only
      fix: Write the scenarios of notes.md as Gherkin in a .feature file, and name that file.
      """

  Scenario: a directory with no feature file
    Given the project "tagged"
    When nuka runs "run empty --json"
    Then it exits with 2
    And the stop is
      """
      severity: refused
      code: no-feature-files
      message: no .feature file was found while scanning "empty"; nothing can run
      fix: Add a .feature file under empty.
      """

  Scenario: a line on a directory
    Given the project "tagged"
    When nuka runs "run empty:3 --json"
    Then it exits with 2
    And the stop is
      """
      severity: refused
      code: line-on-directory
      message: ":line" has no meaning for a directory: empty:3 names a directory, not a feature file
      fix: Remove the :line suffix from the directory, or name a feature file.
      do: nuka run empty
      """

  Scenario: a tag no selected scenario carries
    Given the project "tagged"
    When nuka runs "run features/other.feature --tag @fast --tag @slow --json"
    Then it exits with 1
    And the stop is
      """
      severity: failed
      code: nothing-selected
      message: no scenario to run: --tag @fast --tag @slow left out the 1 scenario of features/other.feature, so nothing was checked
      fix: Name a tag a scenario of the targets carries, or run without --tag.
      """

  Scenario: a tag no scenario of the features directory carries
    Given the project "tagged"
    When nuka runs "run --tag @nothing --json"
    Then it exits with 1
    And the stop is
      """
      severity: failed
      code: nothing-selected
      message: no scenario to run: --tag @nothing left out all 6 scenarios of features, so nothing was checked
      fix: Name a tag a scenario of the targets carries, or run without --tag.
      """

  Scenario: a tag expression nuka run does not read
    Given the project "tagged"
    When nuka runs "run --tag fast --json"
    Then it exits with 2
    And the stop is
      """
      severity: refused
      code: invalid-value
      message: --tag "fast" is not an expression nuka run reads: give "@name" or "not @name", and repeat --tag for a scenario that has to meet more than one
      fix: Correct the flag's value as the message says.
      do: nuka run --help
      """

  Scenario: a tag beside a line
    Given the project "tagged"
    When nuka runs "run features/tagged.feature:5 --tag @fast --json"
    Then it exits with 2
    And the stop is
      """
      severity: refused
      code: invalid-value
      message: --tag selects among whole files, and "features/tagged.feature:5" already names one scenario
      fix: Drop --tag to run that scenario, or drop the :line to select by tag in its file.
      """

  Scenario: an unknown flag
    Given the project "tagged"
    When nuka runs "run --frob --json"
    Then it exits with 2
    And the stop is
      """
      severity: refused
      code: invalid-arguments
      message: Unknown argument: frob
      fix: Correct the command line; the command's --help lists its flags.
      do: nuka run --help
      """

  Scenario: an environment the program file does not define
    Given the project "worlds"
    When nuka runs "run --env nope --json"
    Then it exits with 2
    And the stop is
      """
      severity: refused
      code: unknown-environment
      message: Unknown environment "nope": not defined in nukadoko.program.*'s "environments"
      fix: Pass --env with a name it accepts (blue, default, green, staging), or add environments.nope to nukadoko.program.*.
      """

  Scenario: an error nuka check reports
    Given the project "broken"
    When nuka runs "run --json"
    Then it exits with 2
    And the stop is
      """
      severity: refused
      code: check-errors
      message: nuka run did not start: nuka check reports 1 error for these scenarios
      fix: Correct each error the findings name, or pass --no-check to run anyway.
      do: nuka check
      """

  Scenario: an environment where no selected scenario's conditions hold
    Given the project "switch"
    When nuka runs "run features/switch.feature:4 --env off --json"
    Then it exits with 1
    And the stop is
      """
      severity: failed
      code: nothing-selected
      message: no scenario to run: the conditions of the 1 selected scenario hold in no environment --env names (off), so nothing was checked
      fix: A run without --env selects on, off (the environments that declare conditions), which meets it.
      do: nuka run features/switch.feature:4
      """
