Feature: the scratch fixture copies a part of the project for a step

  scratch.copy(source) gives a step a fresh directory that holds a copy of source, resolved against the project, and removed when the scenario ends.
  A step with no args names only the fixtures its body needs.

  Scenario: a step copies a directory of the project and reads the copy
    Given the project "scratch-copy"
    When nuka runs "run"
    Then it exits with 0
