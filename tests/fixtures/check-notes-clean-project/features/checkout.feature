Feature: Projects

  Scenario: create and close a project
    Given a project "acme" exists
    Then the project is closed
