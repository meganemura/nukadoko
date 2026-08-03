Feature: from resolves an upstream bound in Background

  Background:
    Given a project "acme" is created

  Scenario: the upstream came from Background, not this scenario's own steps
    Then the project is archived
