Feature: a matches claim reads its pattern as JavaScript does

  The TypeScript engine builds a matches claim's pattern with JavaScript's RegExp and no flags, in the grammar browsers keep for old pages.
  There, ^ and $ match only at the ends of the text, \s takes every Unicode space, an escaped letter with no meaning is the letter, a brace that starts no count is a brace, [^] takes any character, a backreference to a group that did not match matches nothing, and a flag group such as (?i) does not build.

  Scenario: a pattern holds and breaks where JavaScript's RegExp says, and a pattern it refuses does not build
    Given the project "js-pattern"
    When nuka runs "run --no-check --json"
    Then it exits with 1
    And the summary is
      """
      <!-- nukadoko:run -->
      # nukadoko run failed: 3 criteria, 1 held, 2 failed

      | verdict | criterion | head default |
      | --- | --- | --- |
      | held | `features/patterns.feature:3` a pattern means what it means to JavaScript | pass |
      | failed | `features/patterns.feature:11` a line end is no end of the text | fail@12 |
      | failed | `features/patterns.feature:14` a flag group JavaScript does not know | fail@15 |

      - `features/patterns.feature:11` a line end is no end of the text: a claim broke at line 12 in default
        - step "the text "a\\u000ab" matches "^b$"": `claim broken: "a\nb" (observe:value) matches "^b$" (sentence:pattern)`; record `steps/step-<id>`
      - `features/patterns.feature:14` a flag group JavaScript does not know: a claim broke at line 15 in default
        - step "the text "a" matches "(?i)a"": `claim broken: "a" (observe:value) matches "(?i)a" (sentence:pattern): matches could not build a regular expression: Invalid regular expression: /(?i)a/: Invalid group`; record `steps/step-<id>`

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

      - `features/patterns.feature:4` the text "Ab" matches "\\Ab"
        - "Ab" (observe:value) matches "\\\\Ab" (sentence:pattern) held; measured: none
      - `features/patterns.feature:5` the text "a\\u00a0b" matches "a\\sb"
        - "a b" (observe:value) matches "a\\\\sb" (sentence:pattern) held; measured: none
      - `features/patterns.feature:6` the text "x" matches "[^]"
        - "x" (observe:value) matches "[^]" (sentence:pattern) held; measured: none
      - `features/patterns.feature:7` the text "ba" matches "(a)\|b\\1"
        - "ba" (observe:value) matches "(a)\|b\\\\1" (sentence:pattern) held; measured: none
      - `features/patterns.feature:8` the text "a{,2}" matches "^a{,2}$"
        - "a{,2}" (observe:value) matches "^a{,2}$" (sentence:pattern) held; measured: none
      - `features/patterns.feature:9` the text "\\u00e9" matches "^.$"
        - "é" (observe:value) matches "^.$" (sentence:pattern) held; measured: none
      - `features/patterns.feature:12` the text "a\\u000ab" matches "^b$"
        - "a\\nb" (observe:value) matches "^b$" (sentence:pattern) broken; measured: none
      - `features/patterns.feature:15` the text "a" matches "(?i)a"
        - "a" (observe:value) matches "(?i)a" (sentence:pattern) broken: matches could not build a regular expression: Invalid regular expression: /(?i)a/: Invalid group; measured: none

      ## Rerun a failed scenario

      ```sh
      nuka run features/patterns.feature:11
      nuka run features/patterns.feature:14
      ```
      """
