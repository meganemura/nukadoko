Feature: stderr redaction b

  Scenario: uses the leaky fixture again
    When a fixture whose teardown can leak a secret is used
