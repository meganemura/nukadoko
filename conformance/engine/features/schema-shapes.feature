Feature: args and returns declare arrays of objects, optional and defaulted keys, and bounds

  A key a from fills in some scenarios and not others is optional, so the scenario that names no producer still runs.
  A defaulted key reads as its default when nothing fills it.

  Scenario: nuka check passes when an optional from key has no producer in one scenario
    Given the project "schema-shapes"
    When nuka runs "check --json"
    Then it exits with 0

  Scenario: a run fills the optional key where a line names it and the default where nothing does
    Given the project "schema-shapes"
    When nuka runs "run --json"
    Then it exits with 0
    And the summary is
      """
      <!-- nukadoko:run -->
      # nukadoko run passed: 2 criteria, 2 held

      | verdict | criterion | head default |
      | --- | --- | --- |
      | held | `features/todos.feature:3` an owner is named | pass |
      | held | `features/todos.feature:10` no owner is named | pass |

      - commit: unknown (no git state was readable when the run started)
      - environment: default
      - browser: none launched
      - selection: full
      - nukadoko: <version>
      - run: run-<id>
      - started <time>, finished <time> (<duration>)

      ## Claims

      Each line is one claim of a Then: the actual value and where it came from, how it was compared, the expected value and where it came from, whether it held, and the recorded channel that holds the actual value (`measured: none` when no channel does, or when another channel holds the same number). An expected value an earlier step returned or `observe` read gets the same, as `expected measured`.

      - `features/todos.feature:7` the count is 2
        - 2 (from:open-todos-counted@6.count) equal 2 (sentence:expected) held; measured: none
      - `features/todos.feature:8` the owner is "aki"
        - "aki" (from:open-todos-counted@6.owner) equal "aki" (sentence:expected) held; measured: none
      - `features/todos.feature:13` the count is 1
        - 1 (from:open-todos-counted@12.count) equal 1 (sentence:expected) held; measured: none
      - `features/todos.feature:14` the owner is "nobody"
        - "nobody" (from:open-todos-counted@12.owner) equal "nobody" (sentence:expected) held; measured: none
      """

