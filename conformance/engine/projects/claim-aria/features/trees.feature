Feature: Trees no page can be judged on

  Scenario: the docstring states a name between slashes
    When the page holds
      """
      <h1>Room 7</h1>
      """
    Then the page shows
      """
      - heading /Room \d+/
      """

  Scenario: the docstring states a number in plain text
    When the page holds
      """
      <p>3.50</p>
      """
    Then the page shows
      """
      - paragraph: 3.50
      """

  Scenario: the capture states a tree that names nothing
    When the page holds
      """
      <h1>Room 7</h1>
      """
    Then the page shows the node '- /children: equal'
