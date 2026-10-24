Feature: a mixed feature for reading the Allure report in a real browser

  Scenario: create and check a thing, with a section and a poll along the way
    Given a thing "widget" exists
    When the thing "widget" is looked up after a section and a poll
    Then the thing "widget" exists

  Scenario: a step throws its own error
    Given a step that always throws

  @hook-fails
  Scenario: a before hook stops the scenario before its own step runs
    Given a thing "widget" exists
