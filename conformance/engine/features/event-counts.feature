Feature: a claim on a count of an earlier step's execution events

  A claim step names a count in events, and a claim reads its key as its actual.
  nukadoko reads the lines of the producer's trace when the claims are judged, and the count is a range: a claim holds or breaks only when every count in the range gives that answer.

  Scenario: a count that is one number holds or breaks
    Given the project "event-counts"
    When nuka runs "run --json features/counts.feature"
    Then it exits with 1
    And the run.json at "scenarios[0].steps[1].claims[0].outcome" is
      """
      "held"
      """
    And the run.json at "scenarios[0].steps[1].claims[0].measured.channel" is
      """
      "events_read.writes"
      """
    And the run.json at "scenarios[0].steps[1].events_read.writes.range" is
      """
      {
        "at_least": 1,
        "at_most": 1
      }
      """
    And the run.json at "findings[0].message" is
      """
      "something was written: claim broken: 1 (events:an-item-is-added@8 count db where op in [insert, update, delete, other], committed true) equal 0 (literal:nothing); counted 1 line: db insert into items"
      """

  Scenario: a reading that is not whole leaves the claim unjudged
    Given the project "event-counts"
    When nuka runs "run --json features/counts.feature"
    Then it exits with 1
    And the run.json at "scenarios[2].steps[1].claims[0].actual_range" is
      """
      {
        "at_least": 0,
        "at_most": null
      }
      """
    And the run.json at "scenarios[2].steps[1].claims[0].reason" is
      """
      "the events of a-job-is-queued@12 are not whole (jobs-pending): job j1 was enqueued and has not performed, so the count is at least 0, with no upper bound, and equal 1 is not known"
      """

  Scenario: a count whose step runs on no earlier line
    Given the project "event-counts"
    When nuka runs "check --json features/order.feature"
    Then it exits with 1
    And the check reports
      """
      error events-producer-missing features/order.feature:4 Step "nothing-was-written"'s events.writes counts the execution events of step "an-item-is-added", and no earlier line runs it: "an-item-is-added" runs nowhere in this scenario. Each claim on the count is unjudged (producer-not-run)
      """

  Scenario: a step's record folds its events into a path
    Given the project "event-counts"
    When nuka runs "run --json features/counts.feature"
    Then it exits with 1
    And the run.json at "scenarios[0].steps[0].path" is
      """
      {
        "entries": [
          {
            "count": 1,
            "kind": "db",
            "op": "insert",
            "table": "items"
          }
        ],
        "maybe": 0,
        "open": [],
        "requests": [
          {
            "method": "POST",
            "route": "/items",
            "status": 201
          }
        ]
      }
      """

  Scenario: a claim judged before its lines arrived turns its cell broke
    Given the project "event-counts"
    When nuka runs "run --json features/arrivals.feature"
    Then it exits with 1
    And the run.json at "scenarios[0].steps[1].claims[0].after_world_stop.outcome" is
      """
      "held"
      """
    And the run.json at "table.rows[0].cells[0].reason" is
      """
      "a claim at line 5 was judged before every execution event it counts had arrived"
      """
    And the run.json at "findings[1].message" is
      """
      "the row arrives after the claim read: a claim at line 5 unjudged before every execution event it counts had arrived, so its cell is broke: 2 lines of the trace of step \"a-slow-item-is-added\" arrived after this claim was judged on 0 lines, and the stop counted 1 more line: db insert into items; over all 2 lines, the count is exactly 1, so the claim holds"
      """
    And the run.json at "limits[0].detail" is
      """
      "2 lines of the program's events after the step ended, in `events-late.jsonl`"
      """
