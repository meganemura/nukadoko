Feature: from's own hint on a genuine args validation failure

  Scenario: an optional args key stays silent through both static checks, but a runtime-only requirement still fails, naming the missing upstream
    Then the project is filed, requiring projectId only at run time

  Scenario: an unfilled from key stays silent when a different key is what actually failed
    Then the project is filed, with an unrelated failure on count "not-a-number"

  Scenario: a step with no from at all fails with no hint suffix
    Then a plain args failure on count "not-a-number"
