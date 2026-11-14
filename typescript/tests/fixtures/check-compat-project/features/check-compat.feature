Feature: compat check integration

  Scenario: everything check needs to see
    Given a typed thing "x" exists
    Given a compat-only thing happens
    When an ambiguous thing happens
    Then the compat outcome is observed
