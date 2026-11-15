Feature: the greeting over HTTP

  Scenario: greets by name
    When I request the greeting for "Ada"
    Then the response body is "Hello, Ada!"

  Scenario: echoes a note
    When I post the note
      """
      hi there
      """
    Then the echoed body is "hi there"
