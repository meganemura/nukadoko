Feature: a serial tag where it does nothing

  @nukadoko:serial
  Scenario: a number doubled on its own
    When I double 2
    Then the doubled number is below 10
