Feature: Condition tags

  @with:banner
  Scenario: the banner is on
    Then the banner reads "on"

  @without:banner @held
  Scenario: the banner is off
    Then the banner reads "off"

  @with:
  Scenario: a tag with no condition
    Then the banner reads "on"

  @with:colour
  Scenario: a condition nothing declares
    Then the banner reads "on"

  @with:banner=on
  Scenario: a value no environment has
    Then the banner reads "on"

  @with:banner @without:banner
  Scenario: two tags no environment meets at once
    Then the banner reads "on"

  @with:banner=true
  Scenario: a boolean written as a value
    Then the banner reads "on"
