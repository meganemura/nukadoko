Feature: the program's functions run in the world's order

  setup runs once the world's program answers, and a url function names a program nukadoko does not start.
  An environment's version function names the version every record of it ran against.

  Scenario: setup runs before the scenarios, and the version names the run
    Given the project "phases-fn"
    When nuka runs "run features/setup.feature --json"
    Then it exits with 0
    And the run.json at "environments[0].target_version" is
      """
      "1.2.3"
      """

  Scenario: a url function names the world's URL
    Given the project "phases-fn"
    When nuka runs "run features/note.feature --env remote --json"
    Then it exits with 0
    And the run.json at "worlds[0].url" is
      """
      "http://localhost:9/remote"
      """

  Scenario: a setup that raises stops the world and says so
    Given the project "phases-fn"
    When nuka runs "run --env failing --json"
    Then it exits with 1
    And the run.json at "worlds[0].error" is
      """
      "setup threw: no seed data"
      """

  Scenario: a version that fails is a warning, never a failed run
    Given the project "phases-fn"
    When nuka runs "run features/note.feature --env lost --json"
    Then it exits with 0
    And the run.json at "environments[0].target_version" is
      """
      null
      """
