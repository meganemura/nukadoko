Feature: runCommand records each process on the step record

  Scenario: two processes in one step, one with a nonzero exit
    Given a step runs two commands

  Scenario: a secret argument is redacted in the recorded command
    Given a step passes a secret to a command

  Scenario: a part's process lands on the calling step
    Given a step calls a part that runs a command

  Scenario: a compat step's process is recorded too
    Given a compat step runs a command

  Scenario: a step that runs nothing has no processes field
    Given a step runs no command
