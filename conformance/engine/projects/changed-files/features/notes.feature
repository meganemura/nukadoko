Feature: notes

  Scenario: the notes are there
    When the notes are written
    Then the notes include "notes/a.txt"
    And 4 files were written

  Scenario: something was written
    When the notes are written
    Then nothing was written
