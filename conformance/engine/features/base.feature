Feature: nuka run --base judges each criterion against a commit

  A new or changed criterion runs at the base too, where the change is absent: a Then failing there in each proof run proves it, and one passing there leaves it unproven.
  An unchanged criterion runs again in the old world, head's code under the base's mapping, when the mapping under it, its tags, or its name changed, and has moved when it does not pass there.
  A criterion the base holds and head does not is listed as removed, quoted as the base has it.

  Scenario: a new criterion that fails at the base is proven, and one that passes there is unproven
    Given the project "base" in a git repository
    When the file "value.txt" reads
      """
      30
      """
    And the file "features/value.feature" reads
      """
      Feature: value

        Scenario: the value stays below a hundred
          Then the value is below 100

        Scenario: the value stays above zero
          Then the value is above 0

        Scenario: the value is large
          Then the value is above 20

        Scenario: the value is above two
          Then the value is above 2
      """
    And nuka runs "run --base HEAD --json"
    Then it exits with 1
    And the summary is
      """
      <!-- nukadoko:run -->
      # nukadoko run failed: 5 criteria, 2 held, 1 proven, 1 removed, 1 unproven

      Compared with `HEAD` (`<commit>`): 2 unchanged, 0 changed, 2 new, 1 removed. The mapping did not change, so no unchanged criterion needed the old world.

      | verdict | criterion | change | head default | base default |
      | --- | --- | --- | --- | --- |
      | held | `features/value.feature:3` the value stays below a hundred | unchanged | pass |  |
      | held | `features/value.feature:6` the value stays above zero | unchanged | pass |  |
      | proven | `features/value.feature:9` the value is large | new | pass | fail@10 (2 runs) |
      | unproven | `features/value.feature:12` the value is above two | new | pass | pass |
      | removed | `features/value.feature:9` the value is not too small | removed |  |  |

      - `features/value.feature:12` the value is above two: passes in default, and nothing shows a Then failing where its behaviour is absent (base default: pass)

      - commit: `<commit>` with uncommitted changes
      - environment: default
      - browser: none launched
      - selection: full
      - nukadoko: <version>
      - run: run-<id>
      - started <time>, finished <time> (<duration>)

      ## Removed criteria

      Each criterion below is in the base and not in head, quoted as the base has it.

      ### `features/value.feature:9` the value is not too small

      ```gherkin
      Then the value is above 1
      ```

      ## Claims

      Each line is one claim of a Then: the actual value and where it came from, how it was compared, the expected value and where it came from, whether it held, and the recorded channel that holds the actual value (`measured: none` when no channel does, or when another channel holds the same number). An expected value an earlier step returned or `observe` read gets the same, as `expected measured`.

      - `features/value.feature:4` the value is below 100
        - 30 (observe:value) less-than 100 (sentence:b) held; measured: none
      - `features/value.feature:7` the value is above 0
        - 30 (observe:value) greater-than 0 (sentence:b) held; measured: none
      - `features/value.feature:10` the value is above 20
        - 30 (observe:value) greater-than 20 (sentence:b) held; measured: none
      - `features/value.feature:13` the value is above 2
        - 30 (observe:value) greater-than 2 (sentence:b) held; measured: none

      ## Findings

      - failed `criterion-unproven` features/value.feature:12: Scenario "the value is above two" is unproven: it passes in default, and nothing shows a Then failing where its behaviour is absent (base default: pass)
      """

  Scenario: an unchanged criterion over a changed mapping runs in the old world
    Given the project "base" in a git repository
    When the file "features/notes.txt" reads
      """
      a file beside the steps is part of the mapping
      """
    And nuka runs "run --base HEAD --json"
    Then it exits with 0
    And the summary is
      """
      <!-- nukadoko:run -->
      # nukadoko run passed: 3 criteria, 3 held

      Compared with `HEAD` (`<commit>`): 3 unchanged, 0 changed, 0 new, 0 removed. The mapping changed (file `features/notes.txt`), so the old world ran each unchanged criterion under the base's steps.

      | verdict | criterion | change | head default | old default |
      | --- | --- | --- | --- | --- |
      | held | `features/value.feature:3` the value stays below a hundred | unchanged | pass | pass |
      | held | `features/value.feature:6` the value stays above zero | unchanged | pass | pass |
      | held | `features/value.feature:9` the value is not too small | unchanged | pass | pass |

      - commit: `<commit>` with uncommitted changes
      - environment: default
      - browser: none launched
      - selection: full
      - nukadoko: <version>
      - run: run-<id>
      - started <time>, finished <time> (<duration>)

      ## Claims

      Each line is one claim of a Then: the actual value and where it came from, how it was compared, the expected value and where it came from, whether it held, and the recorded channel that holds the actual value (`measured: none` when no channel does, or when another channel holds the same number). An expected value an earlier step returned or `observe` read gets the same, as `expected measured`.

      - `features/value.feature:4` the value is below 100
        - 5 (observe:value) less-than 100 (sentence:b) held; measured: none
      - `features/value.feature:7` the value is above 0
        - 5 (observe:value) greater-than 0 (sentence:b) held; measured: none
      - `features/value.feature:10` the value is above 1
        - 5 (observe:value) greater-than 1 (sentence:b) held; measured: none
      """

  Scenario: an unchanged criterion the old world does not pass has moved
    Given the project "base" in a git repository
    When the file "value.txt" reads
      """
      500
      """
    And the file "features/scale.txt" reads
      """
      10
      """
    And the file "features/value.feature" reads
      """
      Feature: value

        Scenario: the value stays below a hundred
          Then the value is below 100

        Scenario: the value stays positive
          Then the value is above 0

        @smoke
        Scenario: the value is not too small
          Then the value is above 1
      """
    And nuka runs "run --base HEAD --json"
    Then it exits with 1
    And the summary is
      """
      <!-- nukadoko:run -->
      # nukadoko run failed: 3 criteria, 2 held, 1 moved

      Compared with `HEAD` (`<commit>`): 3 unchanged, 0 changed, 0 new, 0 removed. The mapping changed (file `features/scale.txt`), so the old world ran each unchanged criterion under the base's steps.

      | verdict | criterion | change | head default | old default |
      | --- | --- | --- | --- | --- |
      | moved | `features/value.feature:3` the value stays below a hundred | unchanged | pass | fail@4 |
      | held | `features/value.feature:6` the value stays positive | unchanged, renamed from `features/value.feature` the value stays above zero | pass | pass |
      | held | `features/value.feature:10` the value is not too small | unchanged, retagged | pass | pass |

      - `features/value.feature:3` the value stays below a hundred: passes in default, but the mapping changed since the base, and a claim broke at line 4 of the base's feature file in the old world in default
        - old: step "the value is below 100": `claim broken: 500 (observe:value) less-than 100 (sentence:b)`; record `steps/step-<id>`

      - commit: `<commit>` with uncommitted changes
      - environment: default
      - browser: none launched
      - selection: full
      - nukadoko: <version>
      - run: run-<id>
      - started <time>, finished <time> (<duration>)

      ## Claims

      Each line is one claim of a Then: the actual value and where it came from, how it was compared, the expected value and where it came from, whether it held, and the recorded channel that holds the actual value (`measured: none` when no channel does, or when another channel holds the same number). An expected value an earlier step returned or `observe` read gets the same, as `expected measured`.

      - `features/value.feature:4` the value is below 100
        - 50 (observe:value) less-than 100 (sentence:b) held; measured: none
      - `features/value.feature:7` the value is above 0
        - 50 (observe:value) greater-than 0 (sentence:b) held; measured: none
      - `features/value.feature:11` the value is above 1
        - 50 (observe:value) greater-than 1 (sentence:b) held; measured: none

      ## Findings

      - failed `criterion-moved` features/value.feature:3: Scenario "the value stays below a hundred" is moved: it passes in default, but the mapping changed since the base, and a claim broke at line 4 of the base's feature file in the old world in default
      """

  Scenario: a base outside git
    Given the project "base"
    When nuka runs "run --base HEAD --json"
    Then it exits with 2
    And the stop is
      """
      severity: refused
      code: base-outside-git
      message: nuka run --base HEAD needs a git repository, and the project directory is not inside one
      fix: Run nuka run --base inside the git repository that holds the project, or run without --base.
      do: nuka run --help
      """

  Scenario: a base that names no commit
    Given the project "base" in a git repository
    When nuka runs "run --base nowhere --json"
    Then it exits with 2
    And the stop is
      """
      severity: refused
      code: base-ref-unknown
      message: --base nowhere names no commit in the project's repository
      fix: Name a branch, tag, or commit the repository holds, such as the pull request's base.
      do: git log --oneline
      """
