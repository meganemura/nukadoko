Feature: a finding on a repeated line is reported once

  Background:
    Given an item is ready
    And a title is set

  Scenario: first
    Then the count is checked

  Scenario Outline: rows
    Then the item is saved
    Given a note is added
      """
      body
      """

    Examples:
      | n |
      | 1 |
      | 2 |
