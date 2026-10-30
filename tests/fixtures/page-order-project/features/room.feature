Feature: What the room page had received when a Then read it

  Scenario: the page had its answer
    When aki opens the room
    Then the room shows "ready"

  Scenario: the page's answer is held back
    When aki opens the room
    And the room starts a refresh held back for 1500 ms
    Then the room shows "ready"

  Scenario: a poll reads until the held-back answer arrives
    When aki opens the room
    And the room starts a refresh held back for 600 ms
    Then the room comes to show "refreshed"

  Scenario: two tabs sent the same request in one step
    When aki opens the room in two tabs
    Then the room shows "ready"
