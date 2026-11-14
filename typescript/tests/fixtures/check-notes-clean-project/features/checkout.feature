Feature: Projects

  Scenario: create and close a project
    Given a project "acme" exists
    When the project is closed
    Then the project is named "acme"
