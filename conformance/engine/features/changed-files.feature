Feature: a Then claims the files an earlier step's commands changed

  A claim step names a list in files, each key with of, the step whose commands changed the files, and optionally change and under.
  nukadoko makes the list from the earlier step's record, the paths its commands added, changed, or removed, never from what its code returned.
  A claim on the key compares the whole list or counts it, and its record names where the list came from and the channel that measured it.
  nuka check names a line whose key no earlier line can supply, or two can, and a run leaves its claims unjudged.

  Scenario: check names each line whose files no single earlier step supplies
    Given the project "changed-files"
    When nuka runs "check --json"
    Then it exits with 1
    And the check reports
      """
      error files-producer-ambiguous features/order.feature:9 Step "nothing-was-written"'s files.changed reads the files the commands of one of steps "write-notes" and "write-more-notes" changed, and "write-notes" and "write-more-notes" each ran earlier in this scenario, so the run cannot choose whose files to read, and each claim on the list is unjudged
      error files-producer-missing features/order.feature:4 Step "notes-include"'s files.written reads the files the commands of step "write-notes" changed, and no earlier line runs it: "write-notes" runs nowhere in this scenario. Each claim on the list is unjudged
      """

  Scenario: a claim reads the paths the earlier step's commands added under a directory
    Given the project "changed-files"
    When nuka runs "run features/notes.feature:3 --json"
    Then it exits with 0
    And the run.json at "scenarios[0].steps[1].claims[0].actual" is
      """
      [
        "notes/a.txt",
        "notes/b.txt"
      ]
      """
    And the run.json at "scenarios[0].steps[1].claims[0].actual_from" is
      """
      "files:write-notes@4 added under notes/"
      """
    And the run.json at "scenarios[0].steps[1].claims[0].measured.channel" is
      """
      "observed.processes[0].files"
      """
    And the run.json at "scenarios[0].steps[2].claims[0].actual_from" is
      """
      "count of files:write-notes@4 added or changed"
      """
    And the run.json at "scenarios[0].steps[2].claims[0].actual" is
      """
      4
      """

  Scenario: a list that is not empty breaks a claim that it is
    Given the project "changed-files"
    When nuka runs "run features/notes.feature:8 --json"
    Then it exits with 1
    And the run.json at "scenarios[0].steps[1].error.message" is
      """
      "claim broken: [\"notes/\",\"notes/a.txt\",\"notes/b.txt\",\"readme.txt\"] (files:write-notes@9 added, changed, or removed) equal [] (literal:nothing); 4 actual items are extra: \"notes/\" (item 0), \"notes/a.txt\" (item 1), \"notes/b.txt\" (item 2), and 1 more"
      """

  Scenario: under --no-check, a key no single earlier step supplies leaves its claim unjudged
    Given the project "changed-files"
    When nuka runs "run features/order.feature --no-check --json"
    Then it exits with 1
    And the run.json at "scenarios[0].steps[0].claims[0].reason" is
      """
      "files.written.of names \"write-notes\", and no earlier line in this scenario ran it, so there is no list of the files it changed"
      """
    And the run.json at "scenarios[1].steps[2].claims[0].reason" is
      """
      "files.changed.of names \"write-notes\" and \"write-more-notes\", and each ran earlier in this scenario, so the step cannot choose whose files to read"
      """

  Scenario: nuka steps names each files key
    Given the project "changed-files"
    When nuka runs "steps --json"
    Then the envelope at "steps[0].files" is
      """
      {
        "written": {
          "change": [
            "added",
            "changed"
          ],
          "of": [
            "write-notes"
          ]
        }
      }
      """
    And the envelope at "steps[1].files" is
      """
      {
        "written": {
          "change": "added",
          "of": [
            "write-notes"
          ],
          "under": "notes"
        }
      }
      """

  Scenario: a files key that no list could fill is an error when the step file loads
    Given the project "files-mistakes"
    When nuka runs "check --json"
    Then it exits with 1
    And the check reports
      """
      error step-file-import-failed features/steps/acting-step.* <step> files belongs to a claim step, and this definition has no claims. A step that acts uses run; a step that judges declares claims.
      error step-file-import-failed features/steps/climbs-out.* <step> files.written.under is "../x", and a record lists each path relative to the command's working directory, with / between its parts, so no path is under it. Name the directory that way, such as "src/".
      error step-file-import-failed features/steps/inside-list.* <step> claims[0].actual reads inside files.written, a list of paths with nothing to walk into. Name the key alone: actual "written".
      error step-file-import-failed features/steps/text-compare.* <step> claims[0] reads files.written, the list of paths an earlier step's commands changed, which is an array of paths, and "contains" does not compare it, so the claim would break on every line or hold on every line. Compare it with equal, not-equal, has-item, has-same-items, or count it.
      error step-file-import-failed features/steps/unread-key.* <step> files.other is read by no claim, so the list it names changes no verdict. Compare a claim with actual "other", or take the key out of files.
      error step-file-import-failed features/steps/wrong-change.* <step> files.written.change must be one of added, changed, removed, or a non-empty list of them; leave it out for every change.
      warning undefined-step-check-suppressed features/steps/acting-step.* Suppressed 1 undefined-step issue because 6 step files could not be read. undefined-step judgment is on hold until the unreadable glue is fixed
      """
