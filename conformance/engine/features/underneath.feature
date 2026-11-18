Feature: failures underneath the steps

  A step can pass while the program fails underneath it: a response with a status from 500 to 599, an error the program reports with handled: false, or an error the page throws that nothing catches.
  Such a pass is broke in its cell unless an @expects: tag of the scenario names the failure, and a tag that matched nothing that happened is noted.

  Scenario: a failure no tag names makes a pass broke
    Given the project "underneath"
    When nuka runs "run --json"
    Then it exits with 1
    And the findings are "unexpected-failure unexpected-failure unexpected-failure unexpected-failure expects-unseen"
    And the run.json at "table.rows[0].cells[0]" is
      """
      {
        "conditions": {},
        "environment": "default",
        "line": 4,
        "outcome": "broke",
        "reason": "the step at line 4 got a 503 response to POST /ask/down, which no @expects tag of the scenario names",
        "role": "required",
        "runs": 1,
        "world": "head"
      }
      """
    And the run.json at "table.rows[2].cells[0].reason" is
      """
      "the program reported an unhandled Boom in the trace of the step at line 13, which no @expects tag of the scenario names"
      """
    And the run.json at "table.rows[6].cells[0].reason" is
      """
      "the page threw an uncaught TypeError while the step at line 31 ran, which no @expects tag of the scenario names"
      """
    And the run.json at "table.rows[8].cells[0].reason" is
      """
      "the step at line 38 got a 503 response to POST /ask/down, which no @expects tag of the scenario names"
      """
    And the run.json at "scenarios[0].steps[0].underneath.statuses[0].status" is
      """
      503
      """

  Scenario: a tag that names the failure accepts it
    Given the project "underneath"
    When nuka runs "run --json features/underneath.feature:8 features/underneath.feature:17 features/underneath.feature:21 features/underneath.feature:34"
    Then it exits with 0
    And the run.json at "table.rows[0].expects" is
      """
      [
        "@expects:status=503"
      ]
      """

  Scenario: a tag whose failure no longer happens is noted
    Given the project "underneath"
    When nuka runs "run --json features/underneath.feature:26"
    Then it exits with 0
    And the findings are "expects-unseen"

  Scenario: a page of a named context sends the step's trace context to the world
    Given the project "underneath"
    When nuka runs "run --json features/underneath.feature:41"
    Then it exits with 0
    And line 2 of the "http.jsonl" of step "scenarios[0].steps[0]" at "as" is
      """
      "aki"
      """
    And the run.json at "scenarios[0].steps[0].observed.events.open" is
      """
      [
        {
          "gap": "request-unreported",
          "requests": 1
        }
      ]
      """
