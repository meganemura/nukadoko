Feature: env files fill the env fixture, and what a secret source holds is redacted in each record

  An env file git does not track, or a project outside git, is a secret source: each value four characters or longer is written as {{secret.NAME}} in a record.
  A tracked env file that matches HEAD is plain configuration.

  Scenario: a value from an env file outside git is redacted in the record nuka do prints
    Given the project "secrets"
    When nuka runs 'do read-the-env --args {}'
    Then it exits with 0
    And the envelope at "result" is
      """
      {
        "short": "abc",
        "token": "{{secret.API_TOKEN}}"
      }
      """

  Scenario: a tracked env file that matches HEAD stays plain
    Given the project "secrets" in a git repository
    When nuka runs 'do read-the-env --args {}'
    Then it exits with 0
    And the envelope at "result" is
      """
      {
        "short": "abc",
        "token": "s3cr3t-value"
      }
      """

  Scenario: what a step prints reaches stderr with the secret redacted, and stdout stays the record
    Given the project "secrets"
    When nuka runs 'do print-the-token --args {}'
    Then it exits with 0
    And the envelope at "result" is
      """
      {}
      """
    And stderr holds "token is {{secret.API_TOKEN}}"
