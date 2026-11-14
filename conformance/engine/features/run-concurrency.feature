Feature: nuka run --concurrency spreads whole feature files over worker processes

  The parent hands the files to the workers in the run's order, round
  robin, and a file whose Feature line is tagged @nukadoko:serial runs
  after them, while no other file runs. Which worker finishes first is not
  fixed, so a scenario here reads what does not depend on it.

  Scenario: a serial file runs after every other file
    Given the project "serial"
    When nuka runs "run --concurrency 2 --json"
    Then it exits with 0
    And the run.json at "scenarios[2].feature" is
      """
      "features/alone.feature"
      """
    And the run.json at "table.rows" is
      """
      [
        {
          "cells": [
            {
              "conditions": {},
              "environment": "default",
              "outcome": "pass",
              "role": "required",
              "runs": 1,
              "world": "head"
            }
          ],
          "change": null,
          "conditions": [],
          "feature": "features/alone.feature",
          "line": 4,
          "name": "a number doubled alone",
          "reason": "passes in default",
          "verdict": "held"
        },
        {
          "cells": [
            {
              "conditions": {},
              "environment": "default",
              "outcome": "pass",
              "role": "required",
              "runs": 1,
              "world": "head"
            }
          ],
          "change": null,
          "conditions": [],
          "feature": "features/also.feature",
          "line": 3,
          "name": "a number doubled beside the first",
          "reason": "passes in default",
          "verdict": "held"
        },
        {
          "cells": [
            {
              "conditions": {},
              "environment": "default",
              "outcome": "pass",
              "role": "required",
              "runs": 1,
              "world": "head"
            }
          ],
          "change": null,
          "conditions": [],
          "feature": "features/beside.feature",
          "line": 3,
          "name": "a number doubled beside another",
          "reason": "passes in default",
          "verdict": "held"
        }
      ]
      """

  Scenario: a rerun line in a shuffled run names the run's own flags
    Given the project "chain"
    When nuka runs "run --concurrency 2 --order shuffled:7 --json"
    Then it exits with 1
    And the run.json at "findings[0].do" is
      """
      "nuka run --order shuffled:7 --concurrency 2"
      """

  Scenario: one file has nothing to spread, so it runs in one process
    Given the project "chain"
    When nuka runs "run features/chain.feature --concurrency 3 --order shuffled:7 --json"
    Then it exits with 1
    And the run.json at "findings[0].do" is
      """
      "nuka run features/chain.feature --order shuffled:7"
      """

  Scenario: a serial tag on a scenario is reported, since it does nothing there
    Given the project "serial-misplaced"
    When nuka runs "check --json"
    Then it exits with 1
    And the envelope at "findings" is
      """
      [
        {
          "code": "serial-tag-on-scenario",
          "file": "features/misplaced.feature",
          "fix": "Move @nukadoko:serial to the Feature line.",
          "line": 4,
          "message": "@nukadoko:serial on scenario \"a number doubled on its own\" has no effect: nuka run --concurrency reads @nukadoko:serial only from the Feature line. Move the tag there.",
          "severity": "error"
        }
      ]
      """

  Scenario: a concurrency of none is refused
    Given the project "chain"
    When nuka runs "run --concurrency 0 --json"
    Then it stops with "invalid-value"
    And the envelope at "findings" is
      """
      [
        {
          "code": "invalid-value",
          "do": "nuka run --help",
          "fix": "Correct the flag's value as the message says.",
          "message": "--concurrency must be a whole number of 1 or more (got 0).",
          "severity": "refused"
        }
      ]
      """
