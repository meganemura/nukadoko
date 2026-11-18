Feature: the MCP calls a step sends through a measured transport

  `measureMcp` (`Nukadoko.measure_mcp` in the gem) wraps an MCP client's transport. Each call a step sends through it is a line of the step's mcp.jsonl, carries the step's trace context in `params._meta.traceparent`, and, over HTTP to the world, as its header too.

  Scenario: a tool call to the world is one line, and the request line for it closes the step's events
    Given the project "measure-mcp"
    When nuka runs "run features/notes.feature:3 --json"
    Then it exits with 0
    And line 1 of the "mcp.jsonl" of step "scenarios[0].steps[0]" at "tool" is
      """
      "add_note"
      """
    And line 1 of the "mcp.jsonl" of step "scenarios[0].steps[0]" at "result.text" is
      """
      "{\"content\":[{\"type\":\"text\",\"text\":\"same\"}]}"
      """
    And the run.json at "scenarios[0].steps[0].observed.mcp" is
      """
      1
      """
    And the run.json at "scenarios[0].steps[0].observed.events.open" is
      """
      []
      """

  Scenario: an error result, a JSON-RPC error, and a notification are each a line
    Given the project "measure-mcp"
    When nuka runs "run features/notes.feature:6 --json"
    Then it exits with 0
    And line 1 of the "mcp.jsonl" of step "scenarios[0].steps[0]" at "is_error" is
      """
      true
      """
    And line 1 of the "mcp.jsonl" of step "scenarios[0].steps[1]" at "error" is
      """
      {
        "code": -32601,
        "message": "no method notes/nope"
      }
      """
    And line 1 of the "mcp.jsonl" of step "scenarios[0].steps[2]" at "notification" is
      """
      true
      """

  Scenario: a call that never reaches the world leaves the step's events open
    Given the project "measure-mcp"
    When nuka runs "run features/notes.feature:11 --json"
    Then it exits with 0
    And line 1 of the "mcp.jsonl" of step "scenarios[0].steps[0]" at "header_sent_to" is
      """
      (nothing at this path)
      """
    And the run.json at "scenarios[0].steps[0].observed.events.open" is
      """
      [
        {
          "calls": 1,
          "gap": "mcp-unbounded"
        }
      ]
      """
