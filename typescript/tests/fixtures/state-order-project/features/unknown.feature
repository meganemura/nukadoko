Feature: What the check cannot read

  Scenario: A compat line between the end and the requirement
    Given aki signs in
    And aki signs out
    And the legacy sign-in runs
    When aki opens the settings page
    Then aki's display name is "aki"

  @hooked
  Scenario: A Before hook that applies
    When aki opens the settings page
    Then aki's display name is "aki"

  @hooked
  Scenario: An end after a Before hook
    Given aki signs in
    And aki signs out
    When aki opens the settings page
    Then aki's display name is "aki"

  @after-each
  Scenario: An AfterStep hook that applies
    Given aki signs in
    And aki signs out
    When aki opens the settings page
    Then aki's display name is "aki"
