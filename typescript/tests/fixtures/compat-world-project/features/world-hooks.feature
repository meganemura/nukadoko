Feature: World and Before/After hooks

  Scenario: an untagged scenario only gets the untagged and not-@excluded hooks
    Then the world visit count is 11

  @tagged
  Scenario: a @tagged scenario also gets the @tagged hook
    Then the world visit count is 111

  @excluded
  Scenario: an @excluded scenario skips the not-@excluded hook
    Then the world visit count is 1

  @before-fails
  Scenario: a failing Before hook skips every step
    Then the world visit count is 11
