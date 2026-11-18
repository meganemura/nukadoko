Feature: notes over MCP

  Scenario: a tool call to the world
    When the MCP tool "add_note" is called

  Scenario: a tool that reports an error, a method the server does not know, and a notification
    When the MCP tool "broken" is called
    And an unknown MCP method is called
    And the MCP client says it is ready

  Scenario: a call that never reaches the world
    When the local MCP tool is called
