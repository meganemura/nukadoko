Feature: a step marks its stages, waits for a state, keeps a file, and reads an earlier result

  Scenario: the total an earlier step made is waited for and kept
    When a total of 3 is made
    And the total is waited for and kept
    Then the kept total is 3
