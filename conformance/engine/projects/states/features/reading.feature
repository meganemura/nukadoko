Feature: reading

  Scenario: a person who signed in opens a book
    Given aki signs in
    When aki opens a book
    And the reader reads
