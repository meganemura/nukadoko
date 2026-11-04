Feature: A step that may give a state without saying so

  Scenario: Through the home page
    Given aki opens the home page
    When aki opens the settings page
    Then aki's display name is "aki"

  Scenario: A state no step gives
    Given aki signs in
    When aki opens the preferences page
    Then aki's display name is "aki"
