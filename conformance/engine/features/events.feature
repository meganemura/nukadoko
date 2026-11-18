Feature: a served world's program writes its execution events to {events}

  nukadoko makes the file {events} names before the world's first command runs, only for a world it serves.
  Each step's lines are the ones whose trace holds the step's trace id, kept beside its record, and its observed.events says what they add up to.
  Once the world stops, the world's redacted copy goes beside program.log, and a step's lines that arrived after its record go beside that record.

  Scenario: each step's lines say whether the work it sent is whole
    Given the project "events"
    When nuka runs "run --json"
    Then it exits with 0
    And the run.json at "scenarios[0].steps[0].observed.events.kinds" is
      """
      {
        "db": 1,
        "request": 1
      }
      """
    And the run.json at "scenarios[0].steps[0].observed.events.open" is
      """
      []
      """
    And the run.json at "scenarios[1].steps[0].observed.events.open" is
      """
      [
        {
          "gap": "jobs-pending",
          "job_ids": [
            "j1"
          ]
        },
        {
          "gap": "unreadable",
          "lines": 1
        }
      ]
      """
    And the run.json at "scenarios[1].steps[1].observed.events.open" is
      """
      [
        {
          "gap": "no-requests"
        }
      ]
      """

  Scenario: a line that arrives after its step ended goes beside that step's record
    Given the project "events"
    When nuka runs "run --json"
    Then it exits with 0
    And the run.json at "scenarios[1].steps[0].events_late" is
      """
      {
        "file": "events-late.jsonl",
        "lines": 1
      }
      """
    And the run.json at "worlds[0].events" is
      """
      {
        "file": "worlds/default/events.jsonl",
        "late": 1,
        "lines": 6,
        "owned": 5,
        "undefined_kinds": {},
        "unowned": 0,
        "unreadable": 1
      }
      """

  Scenario: a world at a url has no events file
    Given the project "events"
    When nuka runs "check --env remote --json"
    Then it exits with 1
    And the check reports
      """
      error program-placeholder-unfilled nukadoko.config.* world remote: env.EVENTS_FILE names {events}, which has no value here: nukadoko does not start this world's program, so it reads no file the program writes
      warning scenario-without-then features/items.feature:3 Scenario "an item is added" has no Then step, so it passes whenever its steps run without an error, and no step checks an outcome.
      warning scenario-without-then features/items.feature:6 Scenario "a job is queued" has no Then step, so it passes whenever its steps run without an error, and no step checks an outcome.
      """
