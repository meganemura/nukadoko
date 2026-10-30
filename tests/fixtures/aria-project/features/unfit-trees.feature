Feature: Trees no page can be judged on

  Scenario: the docstring states a text with no words
    When a person opens room 7
    Then the page shows
      """
      - text: ""
      """

  Scenario: the docstring states a name between slashes
    When a person opens room 7
    Then the page shows
      """
      - heading /Room \d+/
      """

  Scenario: the capture states a tree that names nothing
    When a person opens room 7
    Then the page shows the node '- /children: equal'
