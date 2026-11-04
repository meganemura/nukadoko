Feature: A Background every scenario shares

  Background:
    When aki opens the settings page

  Scenario: The display name
    Then aki's display name is "aki"

  Scenario: Signing out
    When aki signs out
