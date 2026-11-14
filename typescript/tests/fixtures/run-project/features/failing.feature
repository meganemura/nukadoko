Feature: Failing scenario

  Scenario: an operation fails partway through
    Given a thing "widget" exists
    When the operation fails
    Then this step never runs
