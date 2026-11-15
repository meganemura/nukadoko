Feature: a step argument reads as the JavaScript package reads it

  The TypeScript engine reads a line's arguments with the JavaScript cucumber-expressions package.
  A word ends at any space JavaScript's \s takes, a float takes the JavaScript pattern and reads as parseFloat reads it, and a bigdecimal is the text as written.
  A float that is only a sign reads as NaN, which args validation refuses in zod's words.

  Scenario: a step argument reads as JavaScript reads it
    Given the project "step-arguments"
    When nuka runs "run --no-check --json"
    Then it exits with 1
    And the summary is
      """
      <!-- nukadoko:run -->
      # nukadoko run failed: 3 criteria, 1 held, 2 failed

      | verdict | criterion | head default |
      | --- | --- | --- |
      | held | `features/arguments.feature:3` a number reads as JavaScript reads it | pass |
      | failed | `features/arguments.feature:8` a word ends at a no-break space | broke@9 |
      | failed | `features/arguments.feature:11` a float that is only a sign | broke@12 |

      - `features/arguments.feature:8` a word ends at a no-break space: stopped at line 9 in default before a claim there was judged
        - step "the word a b reads as "a"": `No step definition matches "the word a b reads as "a""`
      - `features/arguments.feature:11` a float that is only a sign: stopped at line 12 in default before a claim there was judged
        - step "the float - reads as "0"": `args validation failed: given: Invalid input: expected number, received NaN`; record `steps/step-<id>`

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

      - `features/arguments.feature:4` the float +.5 reads as "0.5"
        - 0.5 (observe:value) equal 0.5 (sentence:expected as json) held; measured: none
      - `features/arguments.feature:5` the integer 007 reads as "7"
        - 7 (observe:value) equal 7 (sentence:expected as json) held; measured: none
      - `features/arguments.feature:6` the decimal 1.50 reads as "1.50"
        - "1.50" (observe:value) equal "1.50" (sentence:expected) held; measured: none

      ## Rerun a failed scenario

      ```sh
      nuka run features/arguments.feature:8
      nuka run features/arguments.feature:11
      ```
      """
