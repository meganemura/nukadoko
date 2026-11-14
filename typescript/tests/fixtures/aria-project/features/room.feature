Feature: The room page

  Scenario: the page shows its heading and the score button inside the form
    When a person opens room 7
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
    When a person opens room 7
    Then the page shows
      """
      - form "Scores":
        - button "Submit"
      """
