Feature: nuka run --env chooses the worlds a run starts

  A project with no program file, or no defaultEnvironments, runs one world named default.
  defaultEnvironments names the worlds a run without --env starts, in its order.
  Each --env names one more, in the order given; default is always a name.

  Scenario: a project with no program file runs the default world
    Given the project "tagged"
    When nuka runs "run features/other.feature --json"
    Then it exits with 0
    And the run lists these scenarios
      """
      features/other.feature:3 default passed
      """

  Scenario: defaultEnvironments starts its worlds in its order
    Given the project "worlds"
    When nuka runs "run --json"
    Then it exits with 0
    And the run lists these scenarios
      """
      features/one.feature:3 blue passed
      features/one.feature:3 green passed
      """

  Scenario: --env starts the named worlds in the order given
    Given the project "worlds"
    When nuka runs "run --env green --env blue --json"
    Then it exits with 0
    And the run lists these scenarios
      """
      features/one.feature:3 green passed
      features/one.feature:3 blue passed
      """

  Scenario: --env reaches a world defaultEnvironments leaves out
    Given the project "worlds"
    When nuka runs "run --env staging --json"
    Then it exits with 0
    And the run lists these scenarios
      """
      features/one.feature:3 staging passed
      """

  Scenario: --env default names the world with no environment
    Given the project "worlds"
    When nuka runs "run --env default --json"
    Then it exits with 0
    And the run lists these scenarios
      """
      features/one.feature:3 default passed
      """

  Scenario: an environment the program does not define is refused
    Given the project "worlds"
    When nuka runs "run --env nope --json"
    Then it exits with 2
    And it stops with "unknown-environment"
