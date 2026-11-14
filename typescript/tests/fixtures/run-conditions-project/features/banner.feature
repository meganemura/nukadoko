Feature: Banner

  Scenario: the banner is on
    Then the banner reads "on"

  Scenario: the banner has a value
    Then the banner matches "^(on|off)$"
