Feature: a text view trims the spaces JavaScript's trim takes

  The TypeScript engine reads a text through the text, lines, and comma-list views with JavaScript's trim, which takes a no-break space, an ideographic space, a byte order mark, and a line separator, and keeps a NUL.
  A comma-list keeps an empty item after a comma at the end, as JavaScript's split does.

  Scenario: a view trims what JavaScript's trim takes, and keeps an empty last item
    Given the project "text-spaces"
    When nuka runs "run --no-check --json"
    Then it exits with 1
    And the summary is
      """
      <!-- nukadoko:run -->
      # nukadoko run failed: 3 criteria, 1 held, 2 failed

      | verdict | criterion | head default |
      | --- | --- | --- |
      | held | `features/spaces.feature:3` a view trims the spaces JavaScript's trim takes | pass |
      | failed | `features/spaces.feature:10` a NUL is no space to trim | fail@11 |
      | failed | `features/spaces.feature:13` a comma at the end leaves an empty item | fail@14 |

      - `features/spaces.feature:10` a NUL is no space to trim: a claim broke at line 11 in default
        - step "the text "x\\u0000" reads as "x"": `claim broken: "x\u0000" (observe:value as text) equal "x" (sentence:expected)`; record `steps/step-<id>`
      - `features/spaces.feature:13` a comma at the end leaves an empty item: a claim broke at line 14 in default
        - step "the list "a,b," reads as '["a","b"]'": `claim broken: ["a","b",""] (observe:value as comma-list) equal ["a","b"] (sentence:expected as json); 1 actual item is extra: "" (item 2)`; record `steps/step-<id>`

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

      - `features/spaces.feature:4` the text "x\\u00a0" reads as "x"
        - "x" (observe:value as text) equal "x" (sentence:expected) held; measured: none
      - `features/spaces.feature:5` the text "x\\u3000\\ufeff\\u2028" reads as "x"
        - "x" (observe:value as text) equal "x" (sentence:expected) held; measured: none
      - `features/spaces.feature:6` the list "a\\u00a0,\\u00a0b" reads as '["a","b"]'
        - ["a","b"] (observe:value as comma-list) equal ["a","b"] (sentence:expected as json) held; measured: none
      - `features/spaces.feature:7` the list "\\u00a0" reads as '[]'
        - [] (observe:value as comma-list) equal [] (sentence:expected as json) held; measured: none
      - `features/spaces.feature:8` the list "a, b," reads as '["a","b",""]'
        - ["a","b",""] (observe:value as comma-list) equal ["a","b",""] (sentence:expected as json) held; measured: none
      - `features/spaces.feature:11` the text "x\\u0000" reads as "x"
        - "x\\u0000" (observe:value as text) equal "x" (sentence:expected) broken; measured: none
      - `features/spaces.feature:14` the list "a,b," reads as '["a","b"]'
        - ["a","b",""] (observe:value as comma-list) equal ["a","b"] (sentence:expected as json) broken; 1 actual item is extra: "" (item 2); measured: none

      ## Rerun a failed scenario

      ```sh
      nuka run features/spaces.feature:10
      nuka run features/spaces.feature:13
      ```
      """
