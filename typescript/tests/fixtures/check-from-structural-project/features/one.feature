Feature: nuka check reports from's structural findings

  Scenario: a valid chain, an unregistered upstream, and a bad returns key
    Given a project "acme" is created
    Then the project is archived
    Then an unregistered upstream step runs
    Then a step with a bad returns key runs
