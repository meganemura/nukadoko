Feature: nuka report renders a finished run again from its run.json

  nuka report reads a run directory alone, so a run.json copied off another machine renders the same.
  Without a run directory it renders the newest run.
  --format markdown writes the run summary, the same text as the summary.md the run wrote.

  Scenario: the newest run rendered as Markdown is its summary
    Given the project "chain"
    When nuka runs "run --json"
    And nuka runs "report --format markdown --out report/summary.md --json"
    And the run's summary is read
    Then it exits with 0
    And the file "report/summary.md" holds that summary

  Scenario: a project with no run has nothing to render
    Given the project "chain"
    When nuka runs "report --format markdown --out report.md --json"
    Then it exits with 2
    And the stop is
      """
      severity: refused
      code: run-not-found
      message: no run under .nukadoko/runs has a run.json
      fix: Name a run directory that holds a run.json, or run nuka run first.
      do: nuka run
      """

  Scenario: Markdown under --json needs a file to go to
    Given the project "chain"
    When nuka runs "report --format markdown --json"
    Then it exits with 2
    And the stop is
      """
      severity: refused
      code: invalid-arguments
      message: nuka report --json needs --out for --format markdown, since the markdown output itself would go to stdout
      fix: Add --out <path>.
      """

  Scenario: the format is required
    Given the project "chain"
    When nuka runs "report --json"
    Then it exits with 2
    And the stop is
      """
      severity: refused
      code: invalid-arguments
      message: Missing required argument: format
      fix: Correct the command line; the command's --help lists its flags.
      do: nuka report --help
      """
