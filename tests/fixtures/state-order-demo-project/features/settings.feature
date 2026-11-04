Feature: Account settings

  Scenario: A person sees their own settings
    When aki opens the settings page
    Then aki's display name is "aki"
