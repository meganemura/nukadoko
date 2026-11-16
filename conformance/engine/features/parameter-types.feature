Feature: a project registers its own parameter types in the config

  The config's parameterTypes registers a type by its name, its regexp, and an optional transformer.
  A line binds a capture of that type, and the transformer gives the value args receives, so a value inside a sentence with no spaces around it is read without quotes.

  Scenario: a custom type reads a value inside a sentence
    Given the project "parameter-types"
    When nuka runs "run --json"
    Then it exits with 0
    And the summary is
      """
      <!-- nukadoko:run -->
      # nukadoko run passed: 1 criterion, 1 held

      | verdict | criterion | head default |
      | --- | --- | --- |
      | held | `features/tasks.feature:3` a custom type reads a value inside a sentence | pass |

      - commit: unknown (no git state was readable when the run started)
      - environment: default
      - browser: none launched
      - selection: full
      - nukadoko: <version>
      - run: run-<id>
      - started <time>, finished <time> (<duration>)

      ## Claims

      Each line is one claim of a Then: the actual value and where it came from, how it was compared, the expected value and where it came from, whether it held, and the recorded channel that holds the actual value (`measured: none` when no channel does, or when another channel holds the same number). An expected value an earlier step returned or `observe` read gets the same, as `expected measured`.

      - `features/tasks.feature:5` 優先度低は"low"と読む
        - "low" (observe:value) equal "low" (sentence:expected) held; measured: none
      - `features/tasks.feature:6` 期限は明日である
        - "明日" (observe:due) equal "明日" (sentence:day) held; measured: none
      """

  Scenario: a claim that compares with a transformed capture, and a type no pattern names
    Given the project "parameter-type-mistakes"
    When nuka runs "check --json"
    Then it exits with 1
    And the check reports
      """
      error claim-expected-transformed features/steps/priority-is.* Step "priority-is"'s claims[0].expected is args.expected, and its pattern "優先度は{expected:priority}である" fills it with the parameter type {priority}, whose transformer rewrites the line's text before the claim reads it, so code would decide what the claim compares. Capture expected with a type that has no transformer, such as {expected:string}, and read it with expected_view if it needs one
      note parameter-type-unused nukadoko.config.* Configured parameter type "spare" is not referenced by any typed or compat pattern.
      """

  Scenario: a custom type that takes a built-in type's name is refused
    Given the project "parameter-type-collision"
    When nuka runs "check --json"
    Then it exits with 1
    And the findings are "parameter-type-invalid undefined-step pattern-unbound parameter-type-unused"

  Scenario: a run under --no-check stops when the parameter types do not register
    Given the project "parameter-type-collision"
    When nuka runs "run --no-check --json"
    Then it exits with 2
    And it stops with "parameter-type-collision"

  Scenario: a run under --no-check leaves a claim on a transformed capture unjudged
    Given the project "parameter-type-mistakes"
    When nuka runs "run --no-check --json"
    Then it exits with 1
    And the summary is
      """
      <!-- nukadoko:run -->
      # nukadoko run failed: 1 criterion, 0 held, 1 failed

      | verdict | criterion | head default |
      | --- | --- | --- |
      | failed | `features/tasks.feature:3` a claim compares with a transformed capture | broke@4 |

      - `features/tasks.feature:3` a claim compares with a transformed capture: stopped at line 4 in default before a claim there was judged
        - step "優先度は高である": `claim unjudged: "high" (observe:value) equal sentence:expected: the pattern "優先度は{expected:priority}である" fills args.expected with the parameter type {priority}, whose transformer rewrites the line's text before the claim reads it, so code would decide what the claim compares, and the claim was not judged`; record `steps/step-<id>`

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

      - `features/tasks.feature:4` 優先度は高である
        - "high" (observe:value) equal sentence:expected unjudged: the pattern "優先度は{expected:priority}である" fills args.expected with the parameter type {priority}, whose transformer rewrites the line's text before the claim reads it, so code would decide what the claim compares, and the claim was not judged; measured: none

      ## Rerun a failed scenario

      ```sh
      nuka run features/tasks.feature:3
      ```
      """
