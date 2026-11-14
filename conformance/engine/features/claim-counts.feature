Feature: nuka judges a count, and an expected value observe read, as the TypeScript engine does

  A claim with count: true compares the number of items of its actual array, and breaks with a reason on a value that is no array.
  An expected { observe } reads what the step observe returned, and a from key in actual still reads the value an earlier step returned.
  Each scenario opens with a When, so no two scenarios share an opening for the run to note.

  Scenario: nuka check names a count of a value that is never an array
    Given the project "claim-counts"
    When nuka runs "check --json"
    Then it exits with 1
    And the check reports
      """
      error claim-not-an-array features/counts.feature:14 Step "name-has"'s claims[0] counts the items of made, and step "make-list" on line 13 returns a string there, never an array, so the claim never holds, whatever the behaviour is
      """

  Scenario: a count holds or breaks with the reason, and observe gives the expected value
    Given the project "claim-counts"
    When nuka runs "run --no-check --json"
    Then it exits with 1
    And the summary is
      """
      <!-- nukadoko:run -->
      # nukadoko run failed: 4 criteria, 1 held, 3 failed

      | verdict | criterion | head default |
      | --- | --- | --- |
      | held | `features/counts.feature:3` a count that holds | pass |
      | failed | `features/counts.feature:8` a count that breaks | fail@10 |
      | failed | `features/counts.feature:12` a count of a value that is no list | fail@14 |
      | failed | `features/counts.feature:16` a shown total that is off | fail@18 |

      - `features/counts.feature:8` a count that breaks: a claim broke at line 10 in default
        - step "the list has 4 items": `claim broken: 3 (count of from:make-list@9.items) equal 4 (sentence:n)`; record `steps/step-<id>`
      - `features/counts.feature:12` a count of a value that is no list: a claim broke at line 14 in default
        - step "the name has 1 items": `claim broken: count of from:make-list@13.name equal 1 (sentence:n): count reads an array, and the value is a string`; record `steps/step-<id>`
      - `features/counts.feature:16` a shown total that is off: a claim broke at line 18 in default
        - step "the list is as long as the shown total plus one": `claim broken: 3 (count of from:make-list@17.items) equal 4 (observe:shown)`; record `steps/step-<id>`

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

      - `features/counts.feature:5` the list has 3 items
        - 3 (count of from:make-list@4.items) equal 3 (sentence:n) held; measured: none
      - `features/counts.feature:6` the list is as long as the shown total
        - 3 (count of from:make-list@4.items) equal 3 (observe:shown) held; measured: none; expected measured: none
      - `features/counts.feature:10` the list has 4 items
        - 3 (count of from:make-list@9.items) equal 4 (sentence:n) broken; measured: none
      - `features/counts.feature:14` the name has 1 items
        - count of from:make-list@13.name equal 1 (sentence:n) broken: count reads an array, and the value is a string; measured: none
      - `features/counts.feature:18` the list is as long as the shown total plus one
        - 3 (count of from:make-list@17.items) equal 4 (observe:shown) broken; measured: none; expected measured: none

      ## Rerun a failed scenario

      ```sh
      nuka run features/counts.feature:8
      nuka run features/counts.feature:12
      nuka run features/counts.feature:16
      ```
      """
