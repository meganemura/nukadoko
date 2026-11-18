Feature: order

  Scenario: no program ran
    Then the notes include "notes/a.txt"

  Scenario: two programs ran
    When the notes are written
    And more notes are written
    Then nothing was written
