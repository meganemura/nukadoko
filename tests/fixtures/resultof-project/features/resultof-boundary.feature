Feature: resultOf never crosses a scenario boundary and never sees a failed result

  Scenario: the referenced step fails
    Given a listing "boom" is created

  Scenario: a fresh scenario never sees another scenario's chain
    Then that listing is closed
