Feature: Account settings

  Scenario: A person sees their own settings
    Given aki signs in
    When aki opens the settings page
    Then aki's display name is "aki"

  Scenario: Settings after signing out
    Given aki signs in
    And aki signs out
    When aki opens the settings page
    Then aki's display name is "aki"

  Scenario: The wrong person signs in
    Given ben signs in
    When aki opens the settings page
    Then aki's display name is "aki"

  Scenario: Nobody signs in
    When aki opens the settings page
    Then aki's display name is "aki"

  Scenario: Signed out on purpose
    Given aki signs in
    And aki signs out
    When aki tries to open the settings page
    Then the browser is on the sign-in page
