Feature: nuka check reports env files and secrets settings that reach nothing, and never prints a value

  A missing env file, a line that loads nothing, and a secrets key no env file defines are warnings.
  A tracked env file that matches HEAD is plain, so a key that looks like a secret there is a warning too.

  Scenario: each env file and secrets setting that reaches nothing is a warning
    Given the project "env-check" in a git repository
    When nuka runs "check --json"
    Then it exits with 0
    And the findings are "env-file-missing env-file-skipped-line secrets-public-key-unknown secrets-redact-key-too-short secrets-redact-key-unknown tracked-secret-looking-key scenario-without-then"
