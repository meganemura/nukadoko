Feature: summary.md says what run.json records, in the same words in each engine

  Each run writes summary.md beside run.json, rendered from run.json alone.
  It opens with the verdict and the counts, then the verdict table, the reason of each red row, what the run does not show, the conditions it ran under, each claim, the findings the table does not show, and the commands that rerun a failed scenario.
  A section with nothing to say is left out.

  Scenario: a red row says why, and the failed scenarios can be run again
    Given the project "chain"
    When nuka runs "run --json"
    Then the summary is
      """
      <!-- nukadoko:run -->
      # nukadoko run failed: 4 criteria, 1 held, 3 failed

      | verdict | criterion | head default |
      | --- | --- | --- |
      | held | `features/chain.feature:3` the doubled number is below the bound | pass |
      | failed | `features/chain.feature:7` the doubled number is not below the bound | fail@9 |
      | failed | `features/errors.feature:3` the steps after a broken claim are skipped | fail@5 |
      | failed | `features/errors.feature:8` a step that raises stops the scenario before its Then | broke@9 |

      - `features/chain.feature:7` the doubled number is not below the bound: a claim broke at line 9 in default
        - step "the doubled number is below 10": `claim broken: 12 (from:double@8.doubled) less-than 10 (sentence:bound)`; record `steps/step-<id>`
      - `features/errors.feature:3` the steps after a broken claim are skipped: a claim broke at line 5 in default
        - step "the doubled number is below 10": `claim broken: 12 (from:double@4.doubled) less-than 10 (sentence:bound)`; record `steps/step-<id>`
      - `features/errors.feature:8` a step that raises stops the scenario before its Then: stopped at line 9 in default before a claim there was judged
        - step "I double 1000": `too big`; record `steps/step-<id>`

      - commit: unknown (no git state was readable when the run started)
      - environment: default
      - browser: none launched
      - selection: full
      - nukadoko: <version>
      - run: run-<id>
      - started <time>, finished <time> (<duration>)

      ## Claims

      Each line is one claim of a Then: the actual value and where it came from, how it was compared, the expected value and where it came from, whether it held, and the recorded channel that holds the actual value (`measured: none` when no channel does, or when another channel holds the same number). An expected value an earlier step returned or `observe` read gets the same, as `expected measured`.

      - `features/chain.feature:5` the doubled number is below 10
        - 6 (from:double@4.doubled) less-than 10 (sentence:bound) held; measured: none
      - `features/chain.feature:9` the doubled number is below 10
        - 12 (from:double@8.doubled) less-than 10 (sentence:bound) broken; measured: none
      - `features/errors.feature:5` the doubled number is below 10
        - 12 (from:double@4.doubled) less-than 10 (sentence:bound) broken; measured: none

      ## Rerun a failed scenario

      ```sh
      nuka run features/chain.feature:7
      nuka run features/errors.feature:3
      nuka run features/errors.feature:8
      ```
      """

  Scenario: a criterion with conditions has a control where they do not hold
    Given the project "switch"
    When nuka runs "run --json"
    Then the summary is
      """
      <!-- nukadoko:run -->
      # nukadoko run passed: 2 criteria in 2 environments, 2 held

      | verdict | criterion | head on (search: true) | head off (search: false) |
      | --- | --- | --- | --- |
      | held | `features/switch.feature:4` a criterion whose control passes too `@with:search` | pass | pass (control) |
      | held | `features/switch.feature:7` a criterion for every environment | pass | pass |

      ## What this run does not show

      Each item below is something the verdicts above do not cover, listed under its kind in run.json's `limits`.

      - **Held, and no control failed at a Then** (`control-not-proving`, 1): a control of each criterion below ran where its conditions do not hold, and none failed at a Then, so nothing shows its Then notices the behaviour is absent
        - `features/switch.feature:4` a criterion whose control passes too: no control failed at a Then where its conditions do not hold (off: pass); fix: make the Then check what its condition switches, or check that the control's environment switches it

      - commit: unknown (no git state was readable when the run started)
      - environment: on (conditions search: true)
      - environment: off (conditions search: false)
      - browser: none launched
      - selection: full
      - nukadoko: <version>
      - run: run-<id>
      - started <time>, finished <time> (<duration>)

      ## Claims

      Each line is one claim of a Then: the actual value and where it came from, how it was compared, the expected value and where it came from, whether it held, and the recorded channel that holds the actual value (`measured: none` when no channel does, or when another channel holds the same number). An expected value an earlier step returned or `observe` read gets the same, as `expected measured`. An entry marked `control` is a control's: a claim it broke is evidence that the scenario tells the behaviour apart, not a failure.

      - `features/switch.feature:5` 1 is below 10 (on)
        - 1 (observe:value) less-than 10 (sentence:b) held; measured: none
      - `features/switch.feature:5` 1 is below 10 (off, control)
        - 1 (observe:value) less-than 10 (sentence:b) held; measured: none
      - `features/switch.feature:8` 2 is below 10 (on)
        - 2 (observe:value) less-than 10 (sentence:b) held; measured: none
      - `features/switch.feature:8` 2 is below 10 (off)
        - 2 (observe:value) less-than 10 (sentence:b) held; measured: none
      """

  Scenario: a run without the static check says so
    Given the project "broken"
    When nuka runs "run --no-check --json"
    Then the summary is
      """
      <!-- nukadoko:run -->
      # nukadoko run failed: 2 criteria, 1 held, 1 failed

      | verdict | criterion | head default |
      | --- | --- | --- |
      | failed | `features/bad.feature:3` a line no step matches | broke@4 |
      | held | `features/good.feature:3` good | pass |

      - `features/bad.feature:3` a line no step matches: stopped at line 4 in default before a claim there was judged
        - step "nothing matches this line": `No step definition matches "nothing matches this line"`

      ## What this run does not show

      Each item below is something the verdicts above do not cover, listed under its kind in run.json's `limits`.

      - **Static check skipped** (`check-skipped`): the run started with `nuka run --no-check`, so no finding of `nuka check` held it back; do: `nuka check`

      - commit: unknown (no git state was readable when the run started)
      - environment: default
      - browser: none launched
      - selection: full
      - nukadoko: <version>
      - run: run-<id>
      - started <time>, finished <time> (<duration>)

      ## Claims

      Each line is one claim of a Then: the actual value and where it came from, how it was compared, the expected value and where it came from, whether it held, and the recorded channel that holds the actual value (`measured: none` when no channel does, or when another channel holds the same number). An expected value an earlier step returned or `observe` read gets the same, as `expected measured`.

      - `features/good.feature:4` 1 is below 10
        - 1 (observe:value) less-than 10 (sentence:b) held; measured: none

      ## Rerun a failed scenario

      ```sh
      nuka run features/bad.feature:3
      ```
      """

  Scenario: a selection by tag names the tags
    Given the project "tagged"
    When nuka runs "run --tag @fast --json"
    Then the summary is
      """
      <!-- nukadoko:run -->
      # nukadoko run passed: 3 criteria, 3 held

      | verdict | criterion | head default |
      | --- | --- | --- |
      | held | `features/tagged.feature:5` a fast one | pass |
      | held | `features/tagged.feature:13` a fast flaky one | pass |
      | held | `features/tagged.feature:22` rows tagged by their Examples | pass |

      - commit: unknown (no git state was readable when the run started)
      - environment: default
      - browser: none launched
      - selection: partial (`--tag "@fast"` left out 3 scenarios of the targeted files)
      - nukadoko: <version>
      - run: run-<id>
      - started <time>, finished <time> (<duration>)

      ## Claims

      Each line is one claim of a Then: the actual value and where it came from, how it was compared, the expected value and where it came from, whether it held, and the recorded channel that holds the actual value (`measured: none` when no channel does, or when another channel holds the same number). An expected value an earlier step returned or `observe` read gets the same, as `expected measured`.

      - `features/tagged.feature:6` 1 is below 10
        - 1 (observe:value) less-than 10 (sentence:b) held; measured: none
      - `features/tagged.feature:14` 3 is below 10
        - 3 (observe:value) less-than 10 (sentence:b) held; measured: none
      - `features/tagged.feature:17` 4 is below 10
        - 4 (observe:value) less-than 10 (sentence:b) held; measured: none
      """
