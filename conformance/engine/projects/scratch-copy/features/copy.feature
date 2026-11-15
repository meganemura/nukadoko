Feature: a step that copies a directory of the project into scratch

  Scenario: the copy holds what the source holds
    When the sample is copied
    Then the copied note says "kept"
