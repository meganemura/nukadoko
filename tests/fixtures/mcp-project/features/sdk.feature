Feature: What an agent's MCP calls through the official client did to the world

  Scenario: a note added over HTTP with the SDK client is one insert
    When the agent adds the note "milk" over HTTP with the SDK client
    Then the SDK HTTP call inserted 1 note

  Scenario: a note added over stdio with the SDK client is at least one insert
    When the agent adds the note "eggs" over stdio with the SDK client
    Then the SDK stdio call inserted at least 1 note
