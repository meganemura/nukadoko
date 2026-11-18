Feature: a world goes through the program's phases in order

  build runs once per tree before any world, prepare once per world with the world's placeholders, and then serve or url.
  A phase that fails, or runs past its timeout_ms, stops the world and names itself.
  A read-only environment refuses every step that declares it mutates.

  Scenario: build and prepare run before the scenarios, and run.json names each command
    Given the project "phases"
    When nuka runs "run features/phases.feature:3 --json"
    Then it exits with 0
    And the run.json at "worlds[0].commands" is
      """
      [
        {
          "argv": [
            "sh",
            "-c",
            "echo built > built.txt"
          ],
          "phase": "build"
        },
        {
          "argv": [
            "sh",
            "-c",
            "echo prepared default > prepared.txt"
          ],
          "phase": "prepare"
        }
      ]
      """

  Scenario: a world at a url is not started, and its log is not read
    Given the project "phases"
    When nuka runs "run features/phases.feature:7 --env remote --json"
    Then it exits with 0
    And the run.json at "worlds[0].url" is
      """
      "http://localhost:9"
      """
    And the run.json at "worlds[0].program_log" is
      """
      null
      """

  Scenario: a build that fails stops the world and names its command
    Given the project "phases"
    When nuka runs "run --env broken --json"
    Then it exits with 1
    And the run.json at "worlds[0].error" is
      """
      "build command sh -c 'echo no compiler; exit 3' exited with code 3"
      """

  Scenario: a prepare past its timeout_ms stops the world
    Given the project "phases"
    When nuka runs "run --env slow --json"
    Then it exits with 1
    And the run.json at "worlds[0].error" is
      """
      "prepare command sleep 5 did not finish within 200 ms (timeout_ms)"
      """

  Scenario: a read-only environment refuses a step that mutates
    Given the project "phases"
    When nuka runs "run features/phases.feature:7 --env locked --json"
    Then it exits with 1
    And the run.json at "scenarios[0].steps[0].error.message" is
      """
      "Step \"a-note-is-written\" mutates state but environment \"locked\" has policy \"read-only\""
      """

  Scenario: a placeholder a world has no value for is a check error
    Given the project "placeholders"
    When nuka runs "check --json"
    Then it exits with 1
    And the check reports
      """
      error program-placeholder-unfilled nukadoko.config.* world default: build[0] names {port}, which has no value here: build runs once per tree, before any world exists
      error program-placeholder-unfilled nukadoko.config.* world default: env.SITE names {url}, which has no value here: this world has neither serve nor url
      warning scenario-without-then features/note.feature:3 Scenario "a note" has no Then step, so it passes whenever its steps run without an error, and no step checks an outcome.
      """
