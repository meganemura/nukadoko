Feature: A declared read is trusted over what it measures

  Scenario: a step declared as a read observes only reads
    Given a setup step exists
    When only a read happens

  Scenario: a step declared as a read observes a write
    Given a setup step exists
    When a write happens
    And a step after the write also runs
