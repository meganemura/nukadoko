Feature: sign-up

  Acceptance criteria (from the request):
  - A registration issues a confirmation link; sign-in works only after the link is opened
  - An email can be registered once
  - A password shorter than 8 characters is refused
  - A wrong password is refused with the same message as an unknown email

  Scenario: sign in after confirming
    Given a registration for "ada@example.com" with password "correct horse" is submitted
    And the confirmation link is opened
    When "ada@example.com" signs in with password "correct horse"
    Then the sign-in is accepted

  Scenario: sign in before confirming
    Given a registration for "ada@example.com" with password "correct horse" is submitted
    When "ada@example.com" signs in with password "correct horse"
    Then the sign-in is refused because "email not confirmed"

  Scenario: the same email twice
    Given a registration for "ada@example.com" with password "correct horse" is submitted
    When a registration for "ada@example.com" with password "other secret" is submitted
    Then the registration is refused because "email already registered"

  Scenario: a short password
    When a registration for "ada@example.com" with password "short" is submitted
    Then the registration is refused because "password shorter than 8 characters"

  Scenario: a wrong password after confirming
    Given a registration for "ada@example.com" with password "correct horse" is submitted
    And the confirmation link is opened
    When "ada@example.com" signs in with password "wrong horse"
    Then the sign-in is refused because "unknown email or wrong password"
