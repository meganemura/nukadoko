Feature: nuka names its commands

  nuka --help lists the commands by what a user reaches them for: Everyday, Exploring, and Upkeep.
  A command nuka does not have is refused, and the refusal points at nuka --help.

  Scenario: --help lists the commands by what they are for
    Given the project "bare"
    When nuka runs "--help"
    Then it exits with 0

  Scenario: a command nuka does not have is refused
    Given the project "bare"
    When nuka runs "bogus"
    Then it exits with 2
    And the stop is
      """
      severity: refused
      code: invalid-arguments
      message: Unknown argument: bogus
      fix: Correct the command line; the command's --help lists its flags.
      do: nuka --help
      """
