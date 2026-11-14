Feature: ctx.poll records how a wait actually went

  Scenario: a poll that resolves on the first try records attempts: 1
    Given a step polls and resolves on the first try

  Scenario: a poll that retries before resolving records more than one attempt
    Given a step polls and resolves after a few retries

  Scenario: a poll that times out fails the step and still records the timeout
    Given a step polls and times out

  Scenario: a poll whose predicate throws fails the step and records the failure
    Given a step polls with a predicate that throws

  Scenario: a step that never calls ctx.poll has no polls field
    Given a step with no polls runs

  Scenario: polls do not bleed across steps sharing one scenario's ctx
    Given poll step alpha runs its own poll
    Given poll step beta runs its own poll

  Scenario: multiple polls in one step land in completion order
    Given a step nests one poll inside another
