Feature: stderr redaction a

  Scenario: uses the leaky fixture
    When a fixture whose teardown can leak a secret is used
