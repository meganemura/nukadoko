Feature: a step's own line, in every shape that nests one

  Background:
    Given a known step runs
    And this background step does not exist

  Rule: a rule wrapping a scenario
    Scenario: inside a rule
      Given a known step runs
      Then this rule step does not exist

  Scenario Outline: an outline whose Examples row sits well below it
    Given a known step runs
    Then this outline step does not exist <n>

    Examples:
      | n |
      | 1 |
