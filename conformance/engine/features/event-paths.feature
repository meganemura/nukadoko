Feature: the paths a run compares

  A run compares what each criterion's steps did on two sides, as their execution events report it: two environments whose conditions differ in one, or, under --base, the base world and head.
  A count that a side's missing lines could still reach is open, never a change, and a write to a table the program marks as bookkeeping is listed apart.

  Scenario: two environments that switch one condition are compared
    Given the project "event-paths"
    When nuka runs "run --json"
    Then it exits with 1
    And the run.json at "paths[0].between" is
      """
      {
        "a": false,
        "b": true,
        "kind": "condition",
        "name": "quick_reorder"
      }
      """
    And the run.json at "paths[0].counts" is
      """
      {
        "changed": 2,
        "marked_only": 1,
        "not_compared": 0,
        "open": 1,
        "same": 1,
        "same_so_far": 0
      }
      """
    And the summary's section "Changed paths" is
      """
      Each criterion below did something else on one side than on the other, or may have, step by step, as the program's execution events report it. A count that a side's missing lines could still reach is listed as open, never as a change. A criterion whose open counts read the same on both sides, under the same gaps, is the same so far, and comes last. Between two environments, what they switch is named in the heading, so no flag's side is listed among the changes.

      ### `reorder-off` → `reorder-on` (`quick_reorder` false → true)

      5 criteria compared: 2 changed, 1 open, 1 different only in bookkeeping or infrastructure writes, 1 the same.

      - `features/paths.feature:3` adding an item
        - line 4 `an item is added`: writes `positions` update 0 → 1
      - `features/paths.feature:21` placing an order
        - line 22 `an order is placed`: requests `POST /orders` 201 → 409
        - lines 23 to 24 ran only in `reorder-off`, since `reorder-on` stopped at line 22 (`broke@22`): 1 request
      - `features/paths.feature:16` mailing the items
        - line 17 `the items are mailed`: open, since neither side is whole (`reorder-off`: `jobs-pending` 1 job; `reorder-on`: `jobs-pending` 2 jobs): jobs `Mail` enqueue 1 or more → 2 or more

      Bookkeeping and infrastructure writes that differ, which no sentence is about, though another reader of those tables may be:

      - `features/paths.feature:7` peeking at the items
        - line 8 `the items are peeked`: writes `visits` insert 1 → 2 (bookkeeping)
      """

  Scenario: under --base, each unchanged criterion runs at the base for its path alone
    Given the project "event-paths" in a git repository
    When nuka runs "run --json --base HEAD --env reorder-off"
    Then it exits with 0
    And the run.json at "scenarios[5].for_paths" is
      """
      {
        "outcome": "pass"
      }
      """
    And the summary's section "Changed paths" is
      """
      Each criterion below did something else on one side than on the other, or may have, step by step, as the program's execution events report it. A count that a side's missing lines could still reach is listed as open, never as a change. A criterion whose open counts read the same on both sides, under the same gaps, is the same so far, and comes last. Between two environments, what they switch is named in the heading, so no flag's side is listed among the changes. Against the base, an unchanged criterion that changed comes first, apart from a new or changed one, whose new sentences account for its difference.

      ### base → head

      5 criteria compared: 1 the same so far, 4 the same.
      Of the 5 unchanged criteria compared, 1 the same so far, 4 the same.

      Criteria that may differ:

      - `features/paths.feature:16` mailing the items: the same so far, with `jobs-pending` on both sides
      """
