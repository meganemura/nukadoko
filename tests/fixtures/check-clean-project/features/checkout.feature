Feature: Projects

  Background:
    Given a project "shared" exists

  Scenario Outline: create and look up a project
    Given a project "<name>" exists
    Then the project "<name>" can be looked up

    Examples:
      | name |
      | acme |
      | beta |

  Scenario: an unknown-position step is not held to Then's mutates rule
    * a project "wild" exists
