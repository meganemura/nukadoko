Feature: Then-position measured enforcement

  Scenario: Then position observes only reads
    Given a setup step exists
    Then only a read happens

  Scenario: Then position observes a write it declares as non-mutating
    Given a setup step exists
    Then a write happens
    And a step after the write also runs
