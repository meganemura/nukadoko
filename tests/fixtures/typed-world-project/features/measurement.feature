Feature: World measurement

  Scenario: a bag field write and read are measured, deduplicated, in order
    When the visit count is incremented
    When the visit count is incremented
    Then the visit count is 2

  Scenario: a step that never touches the World gets no world field
    Then a step that never touches the World runs

  Scenario: an undeclared key introduced mid-step is measured starting the next step
    Given a fresh field is created with "hello"
    Then the fresh field equals "hello"

  Scenario: a #private field stays reachable through a method
    Then the secret is revealed correctly
