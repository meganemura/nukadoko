Feature: Banner

  @with:banner
  Scenario: the banner is on
    Then the banner reads "on"

  @without:banner
  Scenario: the banner is off
    Then the banner reads "off"
