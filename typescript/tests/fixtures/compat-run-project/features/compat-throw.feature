Feature: compat throwing step

  Scenario: a throwing compat step fails and skips the rest
    When a legacy step blows up
    Then the legacy flag is yes
