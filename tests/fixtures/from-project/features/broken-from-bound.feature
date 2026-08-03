Feature: nuka run refuses a bound step whose from is structurally broken

  Scenario: refuses before any scenario record is written
    Then a step with a broken from is bound
