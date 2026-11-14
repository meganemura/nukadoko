Feature: nuka judges an ARIA snapshot claim as the TypeScript engine does

  A fits-aria-snapshot claim judges the tree nukadoko took of the locator or page observe returns against the tree the line states.
  nuka check names a docstring or a capture that states a tree no page can be judged on, and the run breaks such a claim with the same reason.
  A broken claim shows the actual lines where the two trees part, and names the first expected line that fits nothing and the nearest actual node.
  Each scenario opens with a When, so no two scenarios share an opening for the run to note.

  Scenario: nuka check names a tree that does not read and a tree that names nothing
    Given the project "claim-aria"
    When nuka runs "check --json"
    Then it exits with 1
    And the check reports
      """
      error claim-aria-snapshot-names-nothing features/trees.feature:28 Step "page-shows-node"'s claims[0].expected is args.tree, which this line's capture fills, and fits-aria-snapshot has an expected ARIA snapshot that names no node, which every page holds, so the claim would break whatever the page shows
      error claim-aria-snapshot-unreadable features/trees.feature:18 Step "page-shows"'s claims[0].expected is args.tree, which this line's docstring fills, and the expected ARIA snapshot does not read: line 1 has the text 3.50, which YAML reads as 3.5: put the text in quotes, "3.50", to state it as written, so the claim would break whatever the page shows
      error claim-aria-snapshot-unreadable features/trees.feature:8 Step "page-shows"'s claims[0].expected is args.tree, which this line's docstring fills, and the expected ARIA snapshot does not read: line 1 names heading with a pattern between slashes, which fits-aria-snapshot does not judge: state the name in double quotes, or claim the part that changes with another claim, so the claim would break whatever the page shows
      """

  Scenario: a tree holds, breaks where it parts from the page, or breaks with the reason its line gives
    Given the project "claim-aria"
    When nuka runs "run --no-check --json"
    Then it exits with 1
    And the summary is
      """
      <!-- nukadoko:run -->
      # nukadoko run failed: 7 criteria, 1 held, 6 failed

      | verdict | criterion | head default | seen |
      | --- | --- | --- | --- |
      | held | `features/aria.feature:3` the page shows its heading and the score button inside the form | pass | [9](<steps/step-<id>/judged/page.png>) [15](<steps/step-<id>/judged/page.png>) |
      | failed | `features/aria.feature:21` the form has no submit button | fail@26 | [26](<steps/step-<id>/judged/page.png>) |
      | failed | `features/aria.feature:32` the heading is at another level | fail@37 | [37](<steps/step-<id>/judged/page.png>) |
      | failed | `features/aria.feature:39` the title is no locator | fail@44 | [44](<steps/step-<id>/judged/page.png>) |
      | failed | `features/trees.feature:3` the docstring states a name between slashes | fail@8 | [8](<steps/step-<id>/judged/page.png>) |
      | failed | `features/trees.feature:13` the docstring states a number in plain text | fail@18 | [18](<steps/step-<id>/judged/page.png>) |
      | failed | `features/trees.feature:23` the capture states a tree that names nothing | fail@28 | [28](<steps/step-<id>/judged/page.png>) |

      - `features/aria.feature:21` the form has no submit button: a claim broke at line 26 in default
        - step "the page shows": `claim broken: "- form \"Scores\":\n  - button \"Score\"" (lines 1 to 2 of ARIA snapshot of observe:page) fits-aria-snapshot "- form \"Scores\":\n  - button \"Submit\"" (sentence:tree); expected line 2 (button "Submit") fits no child of form "Scores" (actual line 1); nearest: button "Score" (actual line 2)`; record `steps/step-<id>`; seen [page](<steps/step-<id>/judged/page.png>)
      - `features/aria.feature:32` the heading is at another level: a claim broke at line 37 in default
        - step "the page shows the node '- heading "Room 7" [level=1]'": `claim broken: "- heading \"Room 7\" [level=2]" (line 1 of ARIA snapshot of observe:page) fits-aria-snapshot "- heading \"Room 7\" [level=1]" (sentence:tree); expected line 1 (heading "Room 7" [level=1]) fits no node of the snapshot; nearest: heading "Room 7" [level=2] (actual line 1), which prints [level=2]`; record `steps/step-<id>`; seen [page](<steps/step-<id>/judged/page.png>)
      - `features/aria.feature:39` the title is no locator: a claim broke at line 44 in default
        - step "the title shows": `claim broken: ARIA snapshot of observe:title fits-aria-snapshot "- heading \"Room\"" (sentence:tree): observe:title is a string, and fits-aria-snapshot takes the ARIA snapshot of a locator or page that observe returns: return the locator or page itself, and nukadoko takes its snapshot`; record `steps/step-<id>`; seen [page](<steps/step-<id>/judged/page.png>)
      - `features/trees.feature:3` the docstring states a name between slashes: a claim broke at line 8 in default
        - step "the page shows": `claim broken: "- heading \"Room 7\" [level=1]" (ARIA snapshot of observe:page) fits-aria-snapshot "- heading /Room \\d+/" (sentence:tree): the expected ARIA snapshot does not read: line 1 names heading with a pattern between slashes, which fits-aria-snapshot does not judge: state the name in double quotes, or claim the part that changes with another claim`; record `steps/step-<id>`; seen [page](<steps/step-<id>/judged/page.png>)
      - `features/trees.feature:13` the docstring states a number in plain text: a claim broke at line 18 in default
        - step "the page shows": `claim broken: "- paragraph: \"3.50\"" (ARIA snapshot of observe:page) fits-aria-snapshot "- paragraph: 3.50" (sentence:tree): the expected ARIA snapshot does not read: line 1 has the text 3.50, which YAML reads as 3.5: put the text in quotes, "3.50", to state it as written`; record `steps/step-<id>`; seen [page](<steps/step-<id>/judged/page.png>)
      - `features/trees.feature:23` the capture states a tree that names nothing: a claim broke at line 28 in default
        - step "the page shows the node '- /children: equal'": `claim broken: "- heading \"Room 7\" [level=1]" (ARIA snapshot of observe:page) fits-aria-snapshot "- /children: equal" (sentence:tree): fits-aria-snapshot has an expected ARIA snapshot that names no node, which every page holds`; record `steps/step-<id>`; seen [page](<steps/step-<id>/judged/page.png>)

      ## What this run does not show

      Each item below is something the verdicts above do not cover, listed under its kind in run.json's `limits`.

      - **Static check skipped** (`check-skipped`): the run started with `nuka run --no-check`, so no finding of `nuka check` held it back; do: `nuka check`

      - commit: unknown (no git state was readable when the run started)
      - environment: default
      - browser: chromium <version>
      - selection: full
      - nukadoko: <version>
      - run: run-<id>
      - started <time>, finished <time> (<duration>)

      ## Claims

      Each line is one claim of a Then: the actual value and where it came from, how it was compared, the expected value and where it came from, whether it held, and the recorded channel that holds the actual value (`measured: none` when no channel does, or when another channel holds the same number). An expected value an earlier step returned or `observe` read gets the same, as `expected measured`. `seen` links what the Then's pages showed right after the reading its claims were judged on, or, for a Then that read no page, the requests its step sent; a capture taken 100 ms or more after the reading says so. The claims judged the values above, not these files, and the scenario's `final.png` is the page as the scenario ended, not as it was judged.

      - `features/aria.feature:9` the page shows; seen: [page](<steps/step-<id>/judged/page.png>)
        - "- heading \\"Room 7\\" [level=1]\\n- form \\"Scores\\":\\n  - textbox \\"Nickname\\": aki\\n  - button \\"Score\\"\\n  - button \\"S... (ARIA snapshot of observe:page) fits-aria-snapshot "- heading \\"Room 7\\" [level=1]\\n- form \\"Scores\\":\\n  - button \\"Score\\"" (sentence:tree) held; measured: none
      - `features/aria.feature:15` the scores form shows, 2 readings; seen: [page](<steps/step-<id>/judged/page.png>)
        - "- form \\"Scores\\":\\n  - textbox \\"Nickname\\": aki\\n  - button \\"Score\\"\\n  - button \\"Skip\\" [disabled]" (ARIA snapshot of observe:form) fits-aria-snapshot "- textbox \\"Nickname\\": aki\\n- button \\"Skip\\" [disabled]" (sentence:tree) held; measured: none
      - `features/aria.feature:26` the page shows; seen: [page](<steps/step-<id>/judged/page.png>)
        - "- form \\"Scores\\":\\n  - button \\"Score\\"" (lines 1 to 2 of ARIA snapshot of observe:page) fits-aria-snapshot "- form \\"Scores\\":\\n  - button \\"Submit\\"" (sentence:tree) broken; expected line 2 (button "Submit") fits no child of form "Scores" (actual line 1); nearest: button "Score" (actual line 2); measured: none
      - `features/aria.feature:37` the page shows the node '- heading "Room 7" [level=1]'; seen: [page](<steps/step-<id>/judged/page.png>)
        - "- heading \\"Room 7\\" [level=2]" (line 1 of ARIA snapshot of observe:page) fits-aria-snapshot "- heading \\"Room 7\\" [level=1]" (sentence:tree) broken; expected line 1 (heading "Room 7" [level=1]) fits no node of the snapshot; nearest: heading "Room 7" [level=2] (actual line 1), which prints [level=2]; measured: none
      - `features/aria.feature:44` the title shows; seen: [page](<steps/step-<id>/judged/page.png>)
        - ARIA snapshot of observe:title fits-aria-snapshot "- heading \\"Room\\"" (sentence:tree) broken: observe:title is a string, and fits-aria-snapshot takes the ARIA snapshot of a locator or page that observe returns: return the locator or page itself, and nukadoko takes its snapshot; measured: none
      - `features/trees.feature:8` the page shows; seen: [page](<steps/step-<id>/judged/page.png>)
        - "- heading \\"Room 7\\" [level=1]" (ARIA snapshot of observe:page) fits-aria-snapshot "- heading /Room \\\\d+/" (sentence:tree) broken: the expected ARIA snapshot does not read: line 1 names heading with a pattern between slashes, which fits-aria-snapshot does not judge: state the name in double quotes, or claim the part that changes with another claim; measured: none
      - `features/trees.feature:18` the page shows; seen: [page](<steps/step-<id>/judged/page.png>)
        - "- paragraph: \\"3.50\\"" (ARIA snapshot of observe:page) fits-aria-snapshot "- paragraph: 3.50" (sentence:tree) broken: the expected ARIA snapshot does not read: line 1 has the text 3.50, which YAML reads as 3.5: put the text in quotes, "3.50", to state it as written; measured: none
      - `features/trees.feature:28` the page shows the node '- /children: equal'; seen: [page](<steps/step-<id>/judged/page.png>)
        - "- heading \\"Room 7\\" [level=1]" (ARIA snapshot of observe:page) fits-aria-snapshot "- /children: equal" (sentence:tree) broken: fits-aria-snapshot has an expected ARIA snapshot that names no node, which every page holds; measured: none

      ## Rerun a failed scenario

      ```sh
      nuka run features/aria.feature:21
      nuka run features/aria.feature:32
      nuka run features/aria.feature:39
      nuka run features/trees.feature:3
      nuka run features/trees.feature:13
      nuka run features/trees.feature:23
      ```
      """
