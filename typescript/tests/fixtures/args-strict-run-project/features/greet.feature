Feature: Strict args validation under nuka run

  Scenario: correct keys pass, an extra key the schema does not declare is refused
    Given a greeting for "ada" exists
    Then a greeting for "ada" tagged "vip" exists
