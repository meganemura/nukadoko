Feature: nuka clean removes what runs left in the state directory

  nuka clean removes each run directory under .nukadoko/runs, each nuka do record under .nukadoko/do, the Allure results nukadoko wrote, and the directories an earlier release left.
  --dry-run lists them and removes nothing.

  Scenario: a dry run lists each run and keeps it
    Given the project "tagged"
    When nuka runs "run --json"
    And nuka runs "clean --dry-run --json"
    Then it exits with 0
    And the envelope at "records" is
      """
      [
        ".nukadoko/runs/run-<id>"
      ]
      """
    And the envelope at "dry_run" is
      """
      true
      """

  Scenario: a clean removes each run, and a second finds nothing
    Given the project "tagged"
    When nuka runs "run --json"
    And nuka runs "clean --json"
    And nuka runs "clean --json"
    Then it exits with 0
    And the envelope at "records" is
      """
      []
      """
