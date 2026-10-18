Feature: Channels nukadoko does not observe

  Scenario: a fetch step after a request step
    Given a setup step exists
    Then only a read happens
    And a fetch read happens
