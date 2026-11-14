Feature: An exact count over stdio

  Scenario: no line bounds a stdio call
    When the agent adds the note "bread" over stdio
    Then the stdio call inserted 1 note
