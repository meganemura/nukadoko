Feature: Several people in one scenario

  Scenario: two people keep their own cookies
    Given aki signs in
    And ben signs in with JavaScript turned off
    Then aki still sees their own name
