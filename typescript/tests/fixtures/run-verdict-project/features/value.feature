Feature: Value

  Scenario: the banner has a value
    Then the banner matches "^(on|off)$"

  @with:banner @held
  Scenario: the banner has a value where it is on
    Then the banner matches "^(on|off)$"
