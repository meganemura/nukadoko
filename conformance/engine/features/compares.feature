Feature: Each compare judges a claim as the TypeScript engine does

  A claim breaks with a reason when its two sides cannot be compared, or when its expected value states nothing, and a broken claim's line says where the two values part.
  The project's steps read a value as JSON or as text, so one feature file reaches every compare below.

  Scenario: nuka check names an is-a claim whose line names no kind
    Given the project "compares"
    When nuka runs "check --json"
    Then it exits with 1
    And the check reports
      """
      error claim-kind-unknown features/compares.feature:26 Step "is-a"'s claims[0].expected is args.kind, which this line fills with "thing", and is-a names one of the kinds string, text, number, integer, boolean, list, array, object, null, uuid, date, timestamp, url, so the claim would always break
      """

  Scenario: has-fields, lacks-field, is-a, equal, and fits-text break with the reason and the difference
    Given the project "compares"
    When nuka runs "run --no-check --json"
    Then it exits with 1
    And the summary is
      """
      <!-- nukadoko:run -->
      # nukadoko run failed: 11 criteria, 1 held, 10 failed

      | verdict | criterion | head default |
      | --- | --- | --- |
      | held | `features/compares.feature:3` fields that fit | pass |
      | failed | `features/compares.feature:13` a field that is missing | fail@14 |
      | failed | `features/compares.feature:16` a list of another length | fail@17 |
      | failed | `features/compares.feature:19` an object with no field | fail@20 |
      | failed | `features/compares.feature:22` a field that is null | fail@23 |
      | failed | `features/compares.feature:25` a kind that is none | fail@26 |
      | failed | `features/compares.feature:28` a date that is no day | fail@29 |
      | failed | `features/compares.feature:31` two types | fail@32 |
      | failed | `features/compares.feature:34` a line that fits nothing | fail@35 |
      | failed | `features/compares.feature:41` a name that reads two texts | fail@42 |
      | failed | `features/compares.feature:48` a line left over | fail@49 |

      - `features/compares.feature:13` a field that is missing: a claim broke at line 14 in default
        - step "the object "{\\"id\\":1,\\"name\\":\\"a\\"}" has the fields "{\\"name\\":\\"a\\",\\"role\\":\\"admin\\"}"": `claim broken: {"id":1,"name":"a"} (observe:value as json) has-fields {"name":"a","role":"admin"} (sentence:fields as json); first field that does not fit at role: actual nothing, expected "admin"`; record `steps/step-<id>`
      - `features/compares.feature:16` a list of another length: a claim broke at line 17 in default
        - step "the object "{\\"tags\\":[\\"x\\"]}" has the fields "{\\"tags\\":[\\"x\\",\\"y\\"]}"": `claim broken: {"tags":["x"]} (observe:value as json) has-fields {"tags":["x","y"]} (sentence:fields as json); first field that does not fit at tags: actual 1 item, expected 2 items`; record `steps/step-<id>`
      - `features/compares.feature:19` an object with no field: a claim broke at line 20 in default
        - step "the object "{\\"id\\":1}" has the fields "{}"": `claim broken: {"id":1} (observe:value as json) has-fields {} (sentence:fields as json): has-fields has an expected object with no field, which every object holds`; record `steps/step-<id>`
      - `features/compares.feature:22` a field that is null: a claim broke at line 23 in default
        - step "the object "{\\"password\\":null}" lacks the field "password"": `claim broken: {"password":null} (observe:value as json) lacks-field "password" (sentence:field); field "password" is present and holds null`; record `steps/step-<id>`
      - `features/compares.feature:25` a kind that is none: a claim broke at line 26 in default
        - step "the value "3" is a "thing"": `claim broken: 3 (observe:value as json) is-a "thing" (sentence:kind): is-a names one of the kinds string, text, number, integer, boolean, list, array, object, null, uuid, date, timestamp, url, and the expected value is "thing"`; record `steps/step-<id>`
      - `features/compares.feature:28` a date that is no day: a claim broke at line 29 in default
        - step "the value "\\"2023-02-29\\"" is a "date"": `claim broken: "2023-02-29" (observe:value as json) is-a "date" (sentence:kind)`; record `steps/step-<id>`
      - `features/compares.feature:31` two types: a claim broke at line 32 in default
        - step "the value "1" equals "\\"1\\""": `claim broken: 1 (observe:value as json) equal "1" (sentence:other as json): equal compares a number with a string`; record `steps/step-<id>`
      - `features/compares.feature:34` a line that fits nothing: a claim broke at line 35 in default
        - step "the output "id 7\\nready\\ndone" fits": `claim broken: "id 7\nready\ndone" (observe:value) fits-text "id [..]\nwaiting" (sentence:text); expected line 1 fits, and expected line 2 fits nothing from actual line 2: actual "ready", expected "waiting"`; record `steps/step-<id>`
      - `features/compares.feature:41` a name that reads two texts: a claim broke at line 42 in default
        - step "the output "id 7\\nagain 8" fits": `claim broken: "id 7\nagain 8" (observe:value) fits-text "id [..:n]\nagain [..:n]" (sentence:text); every expected line fits, but [..:n] reads "7" and then "8" in actual lines 1 and 2: actual "id 7", then "again 8"`; record `steps/step-<id>`
      - `features/compares.feature:48` a line left over: a claim broke at line 49 in default
        - step "the output "a\\nb" fits": `claim broken: "a\nb" (observe:value) fits-text "a" (sentence:text); every expected line fits, and actual line 2 is left over: actual "b"`; record `steps/step-<id>`

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

      - `features/compares.feature:4` the object "{\\"id\\":1,\\"name\\":\\"a\\",\\"tags\\":[\\"x\\"]}" has the fields "{\\"name\\":\\"a\\",\\"tags\\":[\\"x\\"]}"
        - {"id":1,"name":"a","tags":["x"]} (observe:value as json) has-fields {"name":"a","tags":["x"]} (sentence:fields as json) held; measured: none
      - `features/compares.feature:5` the object "{\\"id\\":1}" lacks the field "password"
        - {"id":1} (observe:value as json) lacks-field "password" (sentence:field) held; measured: none
      - `features/compares.feature:6` the value "\\"0190a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b\\"" is a "uuid"
        - "0190a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b" (observe:value as json) is-a "uuid" (sentence:kind) held; measured: none
      - `features/compares.feature:7` the output "id 7\\nready" fits
        - "id 7\\nready" (observe:value) fits-text "id [..:n]\\n..." (sentence:text) held; measured: none
      - `features/compares.feature:14` the object "{\\"id\\":1,\\"name\\":\\"a\\"}" has the fields "{\\"name\\":\\"a\\",\\"role\\":\\"admin\\"}"
        - {"id":1,"name":"a"} (observe:value as json) has-fields {"name":"a","role":"admin"} (sentence:fields as json) broken; first field that does not fit at role: actual nothing, expected "admin"; measured: none
      - `features/compares.feature:17` the object "{\\"tags\\":[\\"x\\"]}" has the fields "{\\"tags\\":[\\"x\\",\\"y\\"]}"
        - {"tags":["x"]} (observe:value as json) has-fields {"tags":["x","y"]} (sentence:fields as json) broken; first field that does not fit at tags: actual 1 item, expected 2 items; measured: none
      - `features/compares.feature:20` the object "{\\"id\\":1}" has the fields "{}"
        - {"id":1} (observe:value as json) has-fields {} (sentence:fields as json) broken: has-fields has an expected object with no field, which every object holds; measured: none
      - `features/compares.feature:23` the object "{\\"password\\":null}" lacks the field "password"
        - {"password":null} (observe:value as json) lacks-field "password" (sentence:field) broken; field "password" is present and holds null; measured: none
      - `features/compares.feature:26` the value "3" is a "thing"
        - 3 (observe:value as json) is-a "thing" (sentence:kind) broken: is-a names one of the kinds string, text, number, integer, boolean, list, array, object, null, uuid, date, timestamp, url, and the expected value is "thing"; measured: none
      - `features/compares.feature:29` the value "\\"2023-02-29\\"" is a "date"
        - "2023-02-29" (observe:value as json) is-a "date" (sentence:kind) broken; measured: none
      - `features/compares.feature:32` the value "1" equals "\\"1\\""
        - 1 (observe:value as json) equal "1" (sentence:other as json) broken: equal compares a number with a string; measured: none
      - `features/compares.feature:35` the output "id 7\\nready\\ndone" fits
        - "id 7\\nready\\ndone" (observe:value) fits-text "id [..]\\nwaiting" (sentence:text) broken; expected line 1 fits, and expected line 2 fits nothing from actual line 2: actual "ready", expected "waiting"; measured: none
      - `features/compares.feature:42` the output "id 7\\nagain 8" fits
        - "id 7\\nagain 8" (observe:value) fits-text "id [..:n]\\nagain [..:n]" (sentence:text) broken; every expected line fits, but [..:n] reads "7" and then "8" in actual lines 1 and 2: actual "id 7", then "again 8"; measured: none
      - `features/compares.feature:49` the output "a\\nb" fits
        - "a\\nb" (observe:value) fits-text "a" (sentence:text) broken; every expected line fits, and actual line 2 is left over: actual "b"; measured: none

      ## Rerun a failed scenario

      ```sh
      nuka run features/compares.feature:13
      nuka run features/compares.feature:16
      nuka run features/compares.feature:19
      nuka run features/compares.feature:22
      nuka run features/compares.feature:25
      nuka run features/compares.feature:28
      nuka run features/compares.feature:31
      nuka run features/compares.feature:34
      nuka run features/compares.feature:41
      nuka run features/compares.feature:48
      ```
      """
