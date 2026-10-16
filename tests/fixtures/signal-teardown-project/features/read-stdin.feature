Feature: read stdin

  Scenario: a step reads file descriptor 0 to its end
    When the step reads stdin
