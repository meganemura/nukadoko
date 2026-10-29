Feature: Notes

  Scenario: Notes sent from the step's own process
    Given a note "milk" is added
    And a note "eggs" is added with a token
    And nothing is sent
    Then the notes include "milk"
