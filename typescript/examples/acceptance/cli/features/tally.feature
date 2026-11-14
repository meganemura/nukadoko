Feature: tally sums amounts per category

  Acceptance criteria (from the request):
  - Given a CSV of category,amount lines, tally prints one "category: total" line per category, sorted by name
  - --json prints the same totals as one JSON object
  - A file that cannot be read is an error with exit code 2
  - A line that is not category,amount is an error with exit code 3

  Scenario: totals per category, sorted by name
    Given a file "input.csv" with these lines
      """
      rent,100
      food,3
      food,2.5
      """
    When I run tally with "input.csv"
    Then it exits with 0
    And the output is
      """
      food: 5.5
      rent: 100
      """

  Scenario: --json prints one object
    Given a file "input.csv" with these lines
      """
      rent,100
      food,3
      """
    When I run tally with "input.csv --json"
    Then it exits with 0
    And the output is
      """
      {"food":3,"rent":100}
      """

  Scenario: a file that cannot be read
    Given an empty directory
    When I run tally with "missing.csv"
    Then it exits with 2
    And the error says "tally: cannot read missing.csv"

  Scenario: a malformed line
    Given a file "input.csv" with these lines
      """
      rent,100
      oops
      """
    When I run tally with "input.csv"
    Then it exits with 3
    And the error says "tally: bad line: oops"
