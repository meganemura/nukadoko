Feature: A custom parameter type's throwing transformer must not crash the whole run

  Scenario: transformer explodes while matching, the rest of the scenario is skipped
    Given the boom value is read
    Then this step never runs
