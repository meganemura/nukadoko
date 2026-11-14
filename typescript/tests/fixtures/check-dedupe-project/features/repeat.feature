Feature: a finding on a repeated line is reported once

  Background:
    Given an item is ready
    And a title is set

  Scenario: first
    Then the count is 0

  Scenario Outline: row <n>
    Then the item is saved
    Given a note is added
      """
      body
      """

    Examples:
      | n |
      | 1 |
      | 2 |

  Scenario: the same text on other lines
    Then the item is saved
    Given nothing defines this step
    And nothing defines this step
