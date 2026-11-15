Feature: nuka run --step walks one scenario a step at a time

  nuka run --step runs one execution of one scenario and pauses after each step until nuka step answers.
  nuka step wait reports where the walk stands, and nuka step next or nuka step stop answers the pause it names, with the walk's number.
  A stop skips the steps after the pause: the scenario is stopped, not failed, and its row is red.
  An answer to a pause the walk is not at, or to a walk that is not the project's, changes nothing and is refused.
  A run that selects more than one execution is refused before anything runs, and the walk records why.

  Scenario: a walk pauses after each step and goes on at next
    Given the project "chain"
    When nuka starts 'run features/chain.feature:3 --step'
    And nuka runs 'step wait --json'
    Then it exits with 0
    And the envelope at "walk" is
      """
      "paused"
      """
    And the envelope at "scenario" is
      """
      {
        "environment": "default",
        "feature": "features/chain.feature",
        "line": 3,
        "name": "the doubled number is below the bound"
      }
      """
    And the envelope at "do" is
      """
      {
        "next": "nuka step next 1 --walk 1",
        "stop": "nuka step stop 1 --walk 1"
      }
      """
    When nuka runs 'step next 1 --walk 1 --json'
    Then the envelope at "pause.text" is
      """
      "the doubled number is below 10"
      """
    And the envelope at "do" is
      """
      {
        "next": "nuka step next 2 --walk 1"
      }
      """
    When nuka runs 'step next 2 --walk 1 --json'
    Then it exits with 0
    And the envelope at "end" is
      """
      {
        "exit_code": 0,
        "findings": [],
        "how": "finished"
      }
      """
    And the started nuka exits with 0

  Scenario: a stop skips the steps after the pause
    Given the project "chain"
    When nuka starts 'run features/chain.feature:3 --step'
    And nuka runs 'step wait'
    And nuka runs 'step stop 1 --walk 1 --json'
    Then it exits with 1
    And the envelope at "end" is
      """
      {
        "exit_code": 1,
        "findings": [
          {
            "code": "walk-stopped",
            "do": "nuka run features/chain.feature:3",
            "file": "features/chain.feature",
            "line": 3,
            "message": "the doubled number is below the bound: the walk was stopped after step 1 (line 4) with nuka step stop, so the steps after it did not run",
            "severity": "failed"
          }
        ],
        "how": "finished",
        "stopped": {
          "after_step": 1,
          "line": 4
        }
      }
      """
    And the run.json at "counts" is
      """
      {
        "controls": 0,
        "controls_not_run": 0,
        "failed": 0,
        "not_run": 0,
        "passed": 0,
        "scenarios": 1,
        "stopped": 1
      }
      """
    And the run.json at "table.rows[0].reason" is
      """
      "the walk was stopped with nuka step stop after line 4 in default, so the steps after it did not run and nothing shows it holds"
      """
    And the run.json at "scenarios[0].steps[1].status" is
      """
      "skipped"
      """
    And the started nuka exits with 1

  Scenario: the same answer again reports where the walk went
    Given the project "chain"
    When nuka starts 'run features/chain.feature:3 --step'
    And nuka runs 'step wait'
    And nuka runs 'step stop 1 --walk 1'
    And nuka runs 'step stop 1 --walk 1 --json'
    Then it exits with 1
    And the envelope at "walk" is
      """
      "ended"
      """
    When nuka runs 'step next 1 --walk 1 --json'
    Then it exits with 2
    And the stop is
      """
      severity: refused
      code: pause-answered
      message: pause 1 was already answered stop, and walk 1 ended: stopped after step 1 (line 4), exit 1, so this next changes nothing
      fix: Run nuka step wait --walk <n> to see where the walk stands, and answer the pause it shows.
      do: nuka step wait --walk 1
      """
    And the started nuka exits with 1

  Scenario: an answer to a pause or a walk that is not current is refused
    Given the project "chain"
    When nuka starts 'run features/chain.feature:3 --step'
    And nuka runs 'step wait'
    And nuka runs 'step next 2 --walk 1 --json'
    Then it exits with 2
    And the stop is
      """
      severity: refused
      code: pause-not-current
      message: pause 2 is not the pause the walk waits at: the walk is at pause 1
      fix: Run nuka step wait --walk <n> to see the pause the walk waits at, and answer that pause.
      do: nuka step wait --walk 1
      """
    When nuka runs 'step next 1 --walk 2 --json'
    Then it exits with 2
    And the stop is
      """
      severity: refused
      code: walk-not-current
      message: this answer is for walk 2, and the walk in this project is walk 1, at pause 1
      fix: Run the nuka step wait the finding names, show the person the pause it prints, and answer with that walk's number.
      do: nuka step wait --walk 1
      """
    When nuka runs 'step next 1 --json'
    Then it exits with 2
    And the stop is
      """
      severity: refused
      code: invalid-value
      message: nuka step next needs --walk, the number of the walk whose pause it answers
      fix: Correct the flag's value as the message says.
      do: nuka step wait
      """
    When nuka runs 'run features/chain.feature:7 --step --json'
    Then it exits with 2
    And the findings are "walk-in-progress"
    When nuka runs 'step stop 1 --walk 1'
    Then the started nuka exits with 1

  Scenario: a pause after a failed step says what failed and offers no stop
    Given the project "chain"
    When nuka starts 'run features/errors.feature:3 --step'
    And nuka runs 'step wait'
    And nuka runs 'step next 1 --walk 1 --json'
    Then it exits with 1
    And the envelope at "pause.status" is
      """
      "failed"
      """
    And the envelope at "pause.remaining" is
      """
      0
      """
    And the envelope at "do" is
      """
      {
        "next": "nuka step next 2 --walk 1"
      }
      """
    And the findings are "walk-failed"
    When nuka runs 'step next 2 --walk 1'
    Then the started nuka exits with 1

  Scenario: a walk of more than one scenario is refused, and the walk says why
    Given the project "chain"
    When nuka runs 'run features/chain.feature --step --json'
    Then it exits with 2
    And the stop is
      """
      severity: refused
      code: step-needs-one-scenario
      message: nuka run --step walks one execution of one scenario, and the targets select 2 scenarios
      fix: Name one scenario with <file>:<line>, one environment with --env, and leave out --repeat and --base.
      do: nuka run features/chain.feature:3 --step
      """
    When nuka runs 'step wait --json'
    Then it exits with 1
    And the envelope at "end.how" is
      """
      "not-run"
      """

  Scenario: nuka clean keeps the run a live walk writes to
    Given the project "chain"
    When nuka starts 'run features/chain.feature:3 --step'
    And nuka runs 'step wait'
    And nuka runs 'clean --json'
    Then it exits with 0
    And the envelope at "kept" is
      """
      [
        ".nukadoko/runs/run-<id>"
      ]
      """
    And the envelope at "findings[0].code" is
      """
      "walk-run-kept"
      """
    When nuka runs 'step stop 1 --walk 1 --json'
    Then the envelope at "end.how" is
      """
      "finished"
      """
    And the started nuka exits with 1
