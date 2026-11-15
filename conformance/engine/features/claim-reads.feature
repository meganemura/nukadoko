Feature: a claim reads its value as the TypeScript engine reads it

  A claim's actual is a path of dot-separated keys into what observe returned, and its at walks on from there.
  A path that finds nothing breaks the claim, naming where the walk stopped.
  A claim judges a plain JSON copy of the value: an integer past Number.MAX_SAFE_INTEGER leaves it unjudged, a whole number is one number, and an object lists its index keys first, as JavaScript holds it.

  Scenario: a claim reads its value as the TypeScript engine reads it
    Given the project "claim-reads"
    When nuka runs "run --no-check --json"
    Then it exits with 1
    And the summary is
      """
      <!-- nukadoko:run -->
      # nukadoko run failed: 6 criteria, 1 held, 5 failed

      | verdict | criterion | head default |
      | --- | --- | --- |
      | held | `features/reads.feature:3` a path reads inside the value, and a whole number is one number | pass |
      | failed | `features/reads.feature:7` a path whose last key is missing | fail@8 |
      | failed | `features/reads.feature:10` a path that stops before its last key | fail@11 |
      | failed | `features/reads.feature:13` an at with nothing there | fail@14 |
      | failed | `features/reads.feature:16` a view of a value that is no text | fail@17 |
      | failed | `features/reads.feature:19` an integer JavaScript cannot hold exactly | broke@20 |

      - `features/reads.feature:7` a path whose last key is missing: a claim broke at line 8 in default
        - step "the name-field of '{"user":{}}' is "aki"": `claim broken: observe:value.user.name equal "aki" (sentence:expected): observe:value.user.name is undefined`; record `steps/step-<id>`
      - `features/reads.feature:10` a path that stops before its last key: a claim broke at line 11 in default
        - step "the name-field of '{}' is "aki"": `claim broken: observe:value.user.name equal "aki" (sentence:expected): observe:value.user.name is undefined, since observe:value has nothing at user`; record `steps/step-<id>`
      - `features/reads.feature:13` an at with nothing there: a claim broke at line 14 in default
        - step "the first-tag of '{"tags":[]}' is "a"": `claim broken: observe:value.tags.0 equal "a" (sentence:expected): observe:value has nothing at tags.0`; record `steps/step-<id>`
      - `features/reads.feature:16` a view of a value that is no text: a claim broke at line 17 in default
        - step "the text-start of '{"a":1}' is "a"": `claim broken: observe:value as text starts-with-text "a" (sentence:expected): view text reads a string, and the value is an object`; record `steps/step-<id>`
      - `features/reads.feature:19` an integer JavaScript cannot hold exactly: stopped at line 20 in default before a claim there was judged
        - step "the whole-value of '[100000000000000000000]' is '[1]'": `claim unjudged: observe:value equal [1] (sentence:expected as json): observe:value.0 is the integer 100000000000000000000, beyond Number.MAX_SAFE_INTEGER, which is not plain JSON, so the claim was not judged: a claim judges a plain JSON copy of the value it reads`; record `steps/step-<id>`

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

      - `features/reads.feature:4` the name-field of '{"user":{"name":"aki"}}' is "aki"
        - "aki" (observe:value.user.name) equal "aki" (sentence:expected) held; measured: none
      - `features/reads.feature:5` the whole-value of '{"b":2.0,"0":1}' is '{"0":1,"b":2}'
        - {"0":1,"b":2} (observe:value) equal {"0":1,"b":2} (sentence:expected as json) held; measured: none
      - `features/reads.feature:8` the name-field of '{"user":{}}' is "aki"
        - observe:value.user.name equal "aki" (sentence:expected) broken: observe:value.user.name is undefined; measured: none
      - `features/reads.feature:11` the name-field of '{}' is "aki"
        - observe:value.user.name equal "aki" (sentence:expected) broken: observe:value.user.name is undefined, since observe:value has nothing at user; measured: none
      - `features/reads.feature:14` the first-tag of '{"tags":[]}' is "a"
        - observe:value.tags.0 equal "a" (sentence:expected) broken: observe:value has nothing at tags.0; measured: none
      - `features/reads.feature:17` the text-start of '{"a":1}' is "a"
        - observe:value as text starts-with-text "a" (sentence:expected) broken: view text reads a string, and the value is an object; measured: none
      - `features/reads.feature:20` the whole-value of '[100000000000000000000]' is '[1]'
        - observe:value equal [1] (sentence:expected as json) unjudged: observe:value.0 is the integer 100000000000000000000, beyond Number.MAX_SAFE_INTEGER, which is not plain JSON, so the claim was not judged: a claim judges a plain JSON copy of the value it reads; measured: none

      ## Rerun a failed scenario

      ```sh
      nuka run features/reads.feature:7
      nuka run features/reads.feature:10
      nuka run features/reads.feature:13
      nuka run features/reads.feature:16
      nuka run features/reads.feature:19
      ```
      """
