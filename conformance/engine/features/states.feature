Feature: a step declares the states it needs, leaves, and ends

  requires names the states a line needs held, gives the states it leaves held, and ends the states it leaves not held.
  An entry is a name, or a name and the args key whose value on the line tells one holder from another.
  nuka check walks every scenario through what its lines declare, and names each line that can only run without a state it requires.
  nuka run refuses such a scenario before any of its steps runs.

  Scenario: check names each line that can only run without its state
    Given the project "states"
    When nuka runs "check --json"
    Then it exits with 1
    And the check reports
      """
      error state-missing features/missing.feature:10 Step "open-a-book" requires "signed-in" for person "aki", and line 9 "aki signs out" (step "sign-out") ends it, with no line between them giving it again; line 11 requires it too. nuka run refuses this scenario before any of its steps runs
      error state-missing features/missing.feature:14 Step "the-reader-reads" requires "signed-in" for a person this line does not name, and by what the earlier lines declare, no person holds it here. nuka run refuses this scenario before any of its steps runs
      error state-missing features/missing.feature:19 Step "pay" requires "paid", and no step gives it, so no line can. nuka run refuses this scenario before any of its steps runs
      error state-missing features/missing.feature:23 Step "open-a-book" requires "signed-in" for person "aki", and no earlier line gives it to aki. nuka run refuses this scenario before any of its steps runs
      error state-missing features/missing.feature:5 Step "open-a-book" requires "signed-in" for person "ben", and no earlier line gives it to ben: line 4 gives it to aki. nuka run refuses this scenario before any of its steps runs
      warning scenario-without-then features/missing.feature:13 Scenario "nobody signed in" has no Then step, so it passes whenever its steps run without an error, and no step checks an outcome.
      warning scenario-without-then features/missing.feature:16 Scenario "nothing pays" has no Then step, so it passes whenever its steps run without an error, and no step checks an outcome.
      warning scenario-without-then features/missing.feature:21 Scenario "a step that names no state ran first" has no Then step, so it passes whenever its steps run without an error, and no step checks an outcome.
      warning scenario-without-then features/missing.feature:3 Scenario "another person signed in" has no Then step, so it passes whenever its steps run without an error, and no step checks an outcome.
      warning scenario-without-then features/missing.feature:7 Scenario "signed out before" has no Then step, so it passes whenever its steps run without an error, and no step checks an outcome.
      warning scenario-without-then features/reading.feature:3 Scenario "a person who signed in opens a book" has no Then step, so it passes whenever its steps run without an error, and no step checks an outcome.
      """

  Scenario: each finding's fix names the line that gives the state
    Given the project "states"
    When nuka runs "check --json"
    Then the envelope at "findings[0].fix" is
      """
      "Put a line that runs step \"sign-in\" (\"ben signs in\") before line 5. If the scenario means to show what happens without \"signed-in\", the line needs a step that does not require it."
      """
    And the envelope at "findings[1].fix" is
      """
      "Put a line that runs step \"sign-in\" (\"aki signs in\") between line 9 and line 10, or move line 9 below line 11. If the scenario means to show what happens without \"signed-in\", the line needs a step that does not require it."
      """
    And the envelope at "findings[3].fix" is
      """
      "Add \"paid\" to the gives of the step that leaves it holding, or correct the name in the requires of step \"pay\". The states steps give: \"signed-in\", \"book-open\"."
      """
    And the envelope at "findings[4].fix" is
      """
      "Put a line that runs step \"sign-in\" (\"aki signs in\") before line 23. Or, if step \"wave\" gives \"signed-in\" without saying so, add [\"signed-in\", \"<key>\"] to its gives. If the scenario means to show what happens without \"signed-in\", the line needs a step that does not require it."
      """

  Scenario: run refuses the scenario before any step runs, even without the check
    Given the project "states"
    When nuka runs "run features/missing.feature:7 --no-check --json"
    Then it exits with 1
    And the run.json at "scenarios[0].steps[0].status" is
      """
      "skipped"
      """
    And the run.json at "scenarios[0].steps[2].status" is
      """
      "failed"
      """
    And the run.json at "scenarios[0].steps[2].error" is
      """
      {
        "kind": null,
        "message": "Step \"open-a-book\" requires \"signed-in\" for person \"aki\", and line 9 \"aki signs out\" (step \"sign-out\") ends it, with no line between them giving it again; line 11 requires it too. nuka run refuses this scenario before any of its steps runs"
      }
      """
    And the run.json at "scenarios[0].steps[3].status" is
      """
      "skipped"
      """

  Scenario: a scenario whose lines give what they require runs
    Given the project "states"
    When nuka runs "run features/reading.feature --json"
    Then it exits with 0

  Scenario: nuka steps names each state and the steps that give it
    Given the project "states"
    When nuka runs "steps --json"
    Then the envelope at "steps[0].requires" is
      """
      [
        {
          "given_by": [
            "sign-in"
          ],
          "key": "person",
          "state": "signed-in"
        }
      ]
      """
    And the envelope at "steps[0].gives" is
      """
      [
        {
          "state": "book-open"
        }
      ]
      """
    And the envelope at "steps[3].ends" is
      """
      [
        {
          "key": "person",
          "state": "signed-in"
        }
      ]
      """

  Scenario: a state written two ways, and entries that are no state, are errors
    Given the project "state-mistakes"
    When nuka runs "check --json"
    Then it exits with 1
    And the check reports
      """
      error state-shape-mismatch features/steps/light.* State "inside" has a holder key in step "enter" and none in step "light", so no line that requires it is judged
      error step-file-import-failed features/steps/hall-is-lit.* <step> gives is not an option of a claim step: a claim step has no action, so it leaves no state; it may require one.
      error step-file-import-failed features/steps/knock.* <step> requires[0] names args key "door", which args does not declare: args declares no key.
      error step-file-import-failed features/steps/leave.* <step> gives[0] and ends[0] both name ["outside", "person"], and a step leaves a state one way.
      error step-file-import-failed features/steps/repeat.* <step> requires[1] names the state " inside", and a state name is not empty and has no space at either end.
      warning scenario-without-then features/mistakes.feature:3 Scenario "a holder key in one step and not in another" has no Then step, so it passes whenever its steps run without an error, and no step checks an outcome.
      """
