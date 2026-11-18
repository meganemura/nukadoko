Feature: the lists a program prints of its places

  A program's lists name its routes, its flags, and its tables, one JSON object per line.
  Each world nukadoko serves reads them once the program answers, and a run sets what its steps did against them.

  Scenario: a run sets the steps' requests and flags against the lists
    Given the project "event-lists"
    When nuka runs "run --json"
    Then it exits with 0
    And the run.json at "worlds[0].lists" is
      """
      {
        "flags": {
          "entries": 1,
          "error": null
        },
        "routes": {
          "entries": 3,
          "error": null
        },
        "tables": {
          "entries": 2,
          "error": null
        }
      }
      """
    And the run.json at "routes[0].route" is
      """
      "/items"
      """
    And the run.json at "routes[0].requests" is
      """
      0
      """
    And the run.json at "flags[0].listed_in" is
      """
      [
        "default"
      ]
      """
    And the run.json at "scenarios[0].steps[3].claims[0].outcome" is
      """
      "held"
      """

  Scenario: a list that is not one list is not read
    Given the project "event-lists"
    When nuka runs "run --json --env broken"
    Then it exits with 1
    And the run.json at "worlds[0].lists.tables.error" is
      """
      "lists.tables command node lists.mjs bad-tables printed a line that is not one entry of the list: line 2 says table \"visits\" holds state, and line 1 says it holds bookkeeping"
      """
    And the run.json at "findings[0].code" is
      """
      "program-list-unread"
      """
