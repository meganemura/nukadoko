Feature: nuka check reports parts findings

  Scenario: broken parts declarations alongside a genuinely correct composite
    Given a project "acme" has "person@example.com" as a member
    Given a step declares a non-step part
    Given a step declares an unregistered part
    Given a read-only step calls a mutating part
    Given cycle step a runs
    Given cycle step b runs
