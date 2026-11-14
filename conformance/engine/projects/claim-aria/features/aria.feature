Feature: ARIA snapshot claims

  Scenario: the page shows its heading and the score button inside the form
    When the page holds
      """
      <h1>Room 7</h1>
      <form aria-label="Scores"><input aria-label="Nickname" value="aki"><button>Score</button><button disabled>Skip</button></form>
      """
    Then the page shows
      """
      - heading "Room 7" [level=1]
      - form "Scores":
        - button "Score"
      """
    And the scores form shows
      """
      - textbox "Nickname": aki
      - button "Skip" [disabled]
      """

  Scenario: the form has no submit button
    When the page holds
      """
      <form aria-label="Scores"><button>Score</button></form>
      """
    Then the page shows
      """
      - form "Scores":
        - button "Submit"
      """

  Scenario: the heading is at another level
    When the page holds
      """
      <h2>Room 7</h2>
      """
    Then the page shows the node '- heading "Room 7" [level=1]'

  Scenario: the title is no locator
    When the page holds
      """
      <title>Room</title>
      """
    Then the title shows
      """
      - heading "Room"
      """
