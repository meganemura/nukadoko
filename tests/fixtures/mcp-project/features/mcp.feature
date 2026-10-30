Feature: What an agent's MCP calls did to the world

  Scenario: a note added over HTTP is one insert
    When the agent adds the note "milk" over HTTP
    Then the HTTP call inserted 1 note

  Scenario: an empty note is refused and writes nothing
    When the agent adds the note "" over HTTP
    Then the HTTP call inserted 0 notes

  Scenario: a tool the server does not have is an error answer
    When the agent calls a tool the server does not have
    Then the server wrote nothing for it

  Scenario: a note added over stdio is at least one insert
    When the agent adds the note "eggs" over stdio
    Then the stdio call inserted at least 1 note
