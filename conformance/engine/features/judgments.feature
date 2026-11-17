Feature: nuka reads a judged-as claim against the committed judgments as the TypeScript engine does

  A judged-as claim compares nothing: the run reads the value, and a judgment a reader records with nuka judge decides it.
  A row keeps its verdict from the machine, and gains a judgment beside it, which is pending until a judgment cites the value the run read, judged once one says it meets, and stale once the value changed since.
  A value in no channel of a step record is uncitable, and nuka judge refuses to record a judgment of it.
  Under --base the run names each judgment file that changed since the base.

  Scenario: a value no judgment cites is pending, and a value in no channel is uncitable
    Given the project "judgments"
    When nuka runs "run --json"
    Then it exits with 1
    And the findings are "judgment-pending judgment-uncitable"
    And the summary is
      """
      <!-- nukadoko:run -->
      # nukadoko run failed: 2 criteria, 2 held, 1 judgment pending, 1 judgment uncitable

      | verdict | judgment | criterion | head default |
      | --- | --- | --- | --- |
      | held | pending | `features/greeting.feature:3` a first-time visitor is greeted | pass |
      | held | uncitable | `features/greeting.feature:7` a cart total is shown | pass |

      - `features/greeting.feature:3` a first-time visitor is greeted: judgment pending: line 5 read "Welcome! Make yourself at home." for a judgment as "friendly to a first-time visitor", and no judgment cites it
      - `features/greeting.feature:7` a cart total is shown: judgment uncitable: line 9 asks for a judgment of from:a-cart@8.total, which no channel of a step record holds, so no judgment can cite it

      - commit: unknown (no git state was readable when the run started)
      - environment: default
      - browser: none launched
      - selection: full
      - nukadoko: <version>
      - run: run-<id>
      - started <time>, finished <time> (<duration>)

      ## Claims

      Each line is one claim of a Then: the actual value and where it came from, how it was compared, the expected value and where it came from, whether it held, and the recorded channel that holds the actual value (`measured: none` when no channel does, or when another channel holds the same number). An expected value an earlier step returned or `observe` read gets the same, as `expected measured`.

      - `features/greeting.feature:5` the greeting reads as "friendly to a first-time visitor"
        - "Welcome! Make yourself at home." (from:run-greet@4.stdout as text) judged-as "friendly to a first-time visitor" (sentence:quality) for-judgment; measured: observed.processes[0].stdout of step-<id>
      - `features/greeting.feature:9` the total reads as "a small number"
        - 12 (from:a-cart@8.total) judged-as "a small number" (sentence:quality) for-judgment; measured: none

      ## Findings

      - failed `judgment-pending` features/greeting.feature:3: Scenario "a first-time visitor is greeted" line 5 read "Welcome! Make yourself at home." for a judgment as "friendly to a first-time visitor", and no judgment cites it
      - failed `judgment-uncitable` features/greeting.feature:7: Scenario "a cart total is shown" line 9 asks for a judgment of from:a-cart@8.total, which no channel of a step record holds, so no judgment can cite it
      """

  Scenario: nuka judge shows the value a criterion asks a judge to read
    Given the project "judgments"
    When nuka runs "run"
    And nuka runs "judge features/greeting.feature:3 --json"
    Then it exits with 0
    And the envelope at "values" is
      """
      [
        {
          "claim": 0,
          "environment": "default",
          "line": 5,
          "measured": "observed.processes[0].stdout of step-<id>",
          "quality": "\"friendly to a first-time visitor\"",
          "record": "steps/step-<id>",
          "seen": [],
          "state": "pending",
          "step": "the greeting reads as \"friendly to a first-time visitor\"",
          "value": "Welcome! Make yourself at home.",
          "value_digest": "sha256:a13063e645a1665939ff4ec6e9992f8d79b934c401aca7d7620375fddf3c73bb",
          "value_from": "from:run-greet@4.stdout as text"
        }
      ]
      """

  Scenario: nuka judge refuses to record a judgment of a value in no channel
    Given the project "judgments"
    When nuka runs "run"
    And nuka runs "judge features/greeting.feature:7 --meets --by ann --because fine --json"
    Then it exits with 2
    And the stop is
      """
      severity: refused
      code: judgment-refused
      message: line 9 read from:a-cart@8.total, which no channel of a step record holds, so a judgment cannot cite it
      fix: Run the criterion, read what nuka judge <file>:<line> prints, and record with exactly one of --meets and --misses, and with --by and --because.
      do: nuka judge --help
      """

  Scenario: a recorded judgment holds its criterion, and goes stale when the value changes
    Given the project "judgments" in a git repository
    When nuka runs "run"
    And nuka runs "judge features/greeting.feature:3 --meets --by ann --because 'It welcomes a newcomer warmly.'"
    And nuka runs "run features/greeting.feature:3 --base HEAD --json"
    Then it exits with 0
    And the summary is
      """
      <!-- nukadoko:run -->
      # nukadoko run passed: 1 criterion, 1 held, 1 judgment judged

      Compared with `HEAD` (`<commit>`): 1 unchanged, 0 changed, 0 new, 0 removed. The mapping did not change, so no unchanged criterion needed the old world. A judgment file changed since the base: `judgments/features/greeting.feature.json`.

      | verdict | judgment | criterion | change | head default |
      | --- | --- | --- | --- | --- |
      | held | judged | `features/greeting.feature:3` a first-time visitor is greeted | unchanged | pass |

      ## What this run does not show

      Each item below is something the verdicts above do not cover, listed under its kind in run.json's `limits`.

      - **Held on a judgment** (`judgment`, 1): each criterion below asks a reader to judge a value its Then read, and a committed judgment cites that value; nukadoko checks the citation, never the judgment
        - `features/greeting.feature:3` a first-time visitor is greeted: stands on a judgment by `ann` that this change added: nukadoko checked that the value is the one judged, not the judgment

      - commit: `<commit>` with uncommitted changes
      - environment: default
      - browser: none launched
      - selection: partial (a line target left out other scenarios of its file)
      - nukadoko: <version>
      - run: run-<id>
      - started <time>, finished <time> (<duration>)

      ## Claims

      Each line is one claim of a Then: the actual value and where it came from, how it was compared, the expected value and where it came from, whether it held, and the recorded channel that holds the actual value (`measured: none` when no channel does, or when another channel holds the same number). An expected value an earlier step returned or `observe` read gets the same, as `expected measured`.

      - `features/greeting.feature:5` the greeting reads as "friendly to a first-time visitor"
        - "Welcome! Make yourself at home." (from:run-greet@4.stdout as text) judged-as "friendly to a first-time visitor" (sentence:quality) for-judgment; measured: observed.processes[0].stdout of step-<id>
      """
    When the file "lib/greeting.txt" reads
      """
      Go away.
      """
    And nuka runs "run features/greeting.feature:3 --json"
    Then it exits with 1
    And the summary is
      """
      <!-- nukadoko:run -->
      # nukadoko run failed: 1 criterion, 1 held, 1 judgment stale

      | verdict | judgment | criterion | head default |
      | --- | --- | --- | --- |
      | held | stale | `features/greeting.feature:3` a first-time visitor is greeted | pass |

      - `features/greeting.feature:3` a first-time visitor is greeted: judgment stale: line 5 read "Go away.", and the judgment by ann in run-<id> cited "Welcome! Make yourself at home.", so it does not cover what ran

      - commit: `<commit>` with uncommitted changes
      - environment: default
      - browser: none launched
      - selection: partial (a line target left out other scenarios of its file)
      - nukadoko: <version>
      - run: run-<id>
      - started <time>, finished <time> (<duration>)

      ## Claims

      Each line is one claim of a Then: the actual value and where it came from, how it was compared, the expected value and where it came from, whether it held, and the recorded channel that holds the actual value (`measured: none` when no channel does, or when another channel holds the same number). An expected value an earlier step returned or `observe` read gets the same, as `expected measured`.

      - `features/greeting.feature:5` the greeting reads as "friendly to a first-time visitor"
        - "Go away." (from:run-greet@4.stdout as text) judged-as "friendly to a first-time visitor" (sentence:quality) for-judgment; measured: observed.processes[0].stdout of step-<id>

      ## Findings

      - failed `judgment-stale` features/greeting.feature:3: Scenario "a first-time visitor is greeted" line 5 read "Go away.", and the judgment by ann in run-<id> cited "Welcome! Make yourself at home.", so it does not cover what ran
      """
