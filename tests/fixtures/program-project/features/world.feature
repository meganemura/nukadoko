Feature: The world the scenarios run against

  Scenario: the program answers with the world's env
    When I ask the program who it is
    Then the program and the step saw the same database
