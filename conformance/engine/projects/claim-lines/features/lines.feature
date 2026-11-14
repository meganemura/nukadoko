Feature: claim steps a check can judge from the step file

  Scenario: a page read once by chance and a docstring nothing reads
    Then the heading says "Home"
    Given a note is kept
    Then the kept note is a string
      """
      hello
      """
