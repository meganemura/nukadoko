Feature: a world builds and prepares before its scenarios

  Scenario: what the build and the prepare wrote
    Then the file "built.txt" holds "built"
    And the file "prepared.txt" holds "prepared default"

  Scenario: a note
    When a note is written
