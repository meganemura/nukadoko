Feature: nuka run --tag chooses scenarios by their tags

  A scenario's tags are its own, its Feature line's, and its Examples block's.
  An expression is @name or not @name. Repeated, a scenario has to meet every one.
  Anything else is refused before a step runs.

  Scenario: one tag keeps the scenarios that carry it, from any of the three places
    Given the project "tagged"
    When nuka runs "run --tag @fast --json"
    Then it exits with 0
    And the run lists these scenarios
      """
      features/tagged.feature:5 default passed
      features/tagged.feature:13 default passed
      features/tagged.feature:22 default passed
      """

  Scenario: a tag on the Feature line reaches every scenario under it
    Given the project "tagged"
    When nuka runs "run --tag @suite --json"
    Then it exits with 0
    And the run lists these scenarios
      """
      features/tagged.feature:5 default passed
      features/tagged.feature:9 default passed
      features/tagged.feature:13 default passed
      features/tagged.feature:22 default passed
      features/tagged.feature:27 default passed
      """

  Scenario: not keeps the scenarios without the tag, untagged files included
    Given the project "tagged"
    When nuka runs "run --tag 'not @suite' --json"
    Then it exits with 0
    And the run lists these scenarios
      """
      features/other.feature:3 default passed
      """

  Scenario: repeated expressions must all hold
    Given the project "tagged"
    When nuka runs "run --tag @fast --tag 'not @flaky' --json"
    Then it exits with 0
    And the run lists these scenarios
      """
      features/tagged.feature:5 default passed
      features/tagged.feature:22 default passed
      """

  Scenario: an expression with and is refused
    Given the project "tagged"
    When nuka runs "run --tag '@fast and @slow' --json"
    Then it exits with 2
    And it stops with "invalid-value"

  Scenario: a tag that leaves out every scenario runs nothing and fails
    Given the project "tagged"
    When nuka runs "run --tag @missing --json"
    Then it exits with 1
    And it stops with "nothing-selected"

  Scenario: a tag beside a line target is refused
    Given the project "tagged"
    When nuka runs "run features/tagged.feature:5 --tag @fast --json"
    Then it exits with 2
    And it stops with "invalid-value"
