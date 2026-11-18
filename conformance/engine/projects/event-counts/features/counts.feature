Feature: counts

  Scenario: the item's row was written
    When an item is added
    Then 1 rows were written to "items"

  Scenario: something was written
    When an item is added
    Then nothing was written

  Scenario: the job's lines did not all read
    When a job is queued
    Then the job performed 1 times
