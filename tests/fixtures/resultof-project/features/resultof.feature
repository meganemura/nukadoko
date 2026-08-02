Feature: resultOf chains a validated result to a later step

  Scenario: a later step reads the earlier step's validated result
    Given a listing "first-widget" is created
    Then that listing is closed

  Scenario: the same step run twice in one scenario: resultOf returns the most recent result
    Given a listing "first" is created
    Given a listing "second" is created
    Then that listing is closed
