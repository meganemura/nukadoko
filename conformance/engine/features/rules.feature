Feature: a feature file groups its scenarios under Rule

  A Rule holds scenarios and its own Background, and every command reads a feature file that has one.

  Scenario: nuka check reads a feature file with rules
    Given the project "rules"
    When nuka runs "check --json"
    Then it exits with 0

  Scenario: a run plays the scenarios under each rule with the rule's background
    Given the project "rules"
    When nuka runs "run --json"
    Then it exits with 0
    And the summary is
      """
      <!-- nukadoko:run -->
      # nukadoko run passed: 2 criteria, 2 held

      | verdict | criterion | head default |
      | --- | --- | --- |
      | held | `features/todos.feature:8` a new todo is open | pass |
      | held | `features/todos.feature:14` a done todo reads done | pass |

      - commit: unknown (no git state was readable when the run started)
      - environment: default
      - browser: none launched
      - selection: full
      - nukadoko: <version>
      - run: run-<id>
      - started <time>, finished <time> (<duration>)

      ## Claims

      Each line is one claim of a Then: the actual value and where it came from, how it was compared, the expected value and where it came from, whether it held, and the recorded channel that holds the actual value (`measured: none` when no channel does, or when another channel holds the same number). An expected value an earlier step returned or `observe` read gets the same, as `expected measured`.

      - `features/todos.feature:10` the todo "sweep" reads "open"
        - "open" (observe:value) equal "open" (sentence:expected) held; measured: none
      - `features/todos.feature:16` the todo "dust" reads "done"
        - "done" (observe:value) equal "done" (sentence:expected) held; measured: none
      """
