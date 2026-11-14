Feature: trace actions expect wait

  Scenario: a step waits for an element that appears after a delay
    Given the page waits for a late element to become visible
