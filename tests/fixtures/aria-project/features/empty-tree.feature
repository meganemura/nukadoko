Feature: A tree that names nothing

  Scenario: the docstring states a text with no words
    When a person opens room 7
    Then the page shows
      """
      - text: ""
      """
