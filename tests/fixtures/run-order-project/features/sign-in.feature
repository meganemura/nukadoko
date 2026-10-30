Feature: Signing in

  Scenario: alice signs in
    When "alice" signs in
    Then the sign-in answers 200
