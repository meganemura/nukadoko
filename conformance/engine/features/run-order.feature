Feature: nuka run plays its selection in an order, again, and more than once

  `--order shuffled:<seed>` sorts the feature files, then each file's
  scenarios, by a key made from the seed and each one's path or line. A
  file stays whole, and the rerun line of a failed scenario names what ran
  before it in that order. `--repeat <n>` plays the selection n times, and
  `--proof-runs <n>` plays each control n times.

  Scenario: a seed names one order, and each rerun line keeps it
    Given the project "chain"
    When nuka runs "run --order shuffled:7 --json"
    Then it exits with 1
    And the run lists these scenarios
      """
      features/errors.feature:8 default failed
      features/errors.feature:3 default failed
      features/chain.feature:3 default passed
      features/chain.feature:7 default failed
      """
    And the run.json at "order" is
      """
      {
        "kind": "shuffled",
        "seed": 7
      }
      """
    And the run.json at "findings" is
      """
      [
        {
          "code": "scenario-failed",
          "do": "nuka run features/errors.feature:8 --order shuffled:7",
          "file": "features/errors.feature",
          "line": 8,
          "message": "a step that raises stops the scenario before its Then: too big",
          "severity": "failed"
        },
        {
          "code": "scenario-failed",
          "do": "nuka run features/errors.feature --order shuffled:7",
          "file": "features/errors.feature",
          "line": 3,
          "message": "the steps after a broken claim are skipped: claim broken: 12 (from:double@4.doubled) less-than 10 (sentence:bound)",
          "severity": "failed"
        },
        {
          "code": "scenario-failed",
          "do": "nuka run features/errors.feature features/chain.feature --order shuffled:7",
          "file": "features/chain.feature",
          "line": 7,
          "message": "the doubled number is not below the bound: claim broken: 12 (from:double@8.doubled) less-than 10 (sentence:bound)",
          "severity": "failed"
        }
      ]
      """

  Scenario: a repeated selection runs each scenario that many times
    Given the project "chain"
    When nuka runs "run features/chain.feature --repeat 2 --json"
    Then it exits with 1
    And the run lists these scenarios
      """
      features/chain.feature:3 default passed
      features/chain.feature:7 default failed
      features/chain.feature:3 default passed
      features/chain.feature:7 default failed
      """
    And the run.json at "table.rows[1].cells" is
      """
      [
        {
          "actuals": [
            {
              "value": 12
            },
            {
              "value": 12
            }
          ],
          "claim": 0,
          "conditions": {},
          "environment": "default",
          "line": 9,
          "outcome": "fail",
          "role": "required",
          "runs": 2,
          "world": "head"
        }
      ]
      """

  Scenario: each control runs the number of proof runs asked for
    Given the project "proof"
    When nuka runs "run --proof-runs 3 --json"
    Then it exits with 0
    And the run.json at "table.rows" is
      """
      [
        {
          "cells": [
            {
              "conditions": {
                "search": true
              },
              "environment": "on",
              "outcome": "pass",
              "role": "required",
              "runs": 1,
              "world": "head"
            },
            {
              "actuals": [
                {
                  "value": "false"
                },
                {
                  "value": "false"
                },
                {
                  "value": "false"
                }
              ],
              "claim": 0,
              "conditions": {
                "search": false
              },
              "environment": "off",
              "line": 5,
              "outcome": "fail",
              "role": "control",
              "runs": 3,
              "world": "head"
            }
          ],
          "change": null,
          "conditions": [
            "@with:search"
          ],
          "feature": "features/proof.feature",
          "line": 4,
          "name": "the search is on",
          "reason": "passes in on, and a claim broke at line 5 in off, where its conditions do not hold, in each of 3 runs",
          "verdict": "proven"
        }
      ]
      """

  Scenario: an order that is not one of the three is refused
    Given the project "chain"
    When nuka runs "run --order sideways --json"
    Then it stops with "invalid-value"
    And the envelope at "findings" is
      """
      [
        {
          "code": "invalid-value",
          "do": "nuka run --help",
          "fix": "Correct the flag's value as the message says.",
          "message": "--order must be file, shuffled, or shuffled:<seed> with a whole number from 0 to 4294967295 (got \"sideways\").",
          "severity": "refused"
        }
      ]
      """

  Scenario: a seed past 32 bits is refused
    Given the project "chain"
    When nuka runs "run --order shuffled:4294967296 --json"
    Then it stops with "invalid-value"
    And the envelope at "findings" is
      """
      [
        {
          "code": "invalid-value",
          "do": "nuka run --help",
          "fix": "Correct the flag's value as the message says.",
          "message": "--order must be file, shuffled, or shuffled:<seed> with a whole number from 0 to 4294967295 (got \"shuffled:4294967296\").",
          "severity": "refused"
        }
      ]
      """

  Scenario: no repeat at all is refused
    Given the project "chain"
    When nuka runs "run --repeat 0 --json"
    Then it stops with "invalid-value"
    And the envelope at "findings" is
      """
      [
        {
          "code": "invalid-value",
          "do": "nuka run --help",
          "fix": "Correct the flag's value as the message says.",
          "message": "--repeat must be a whole number of 1 or more (got 0).",
          "severity": "refused"
        }
      ]
      """

  Scenario: no proof run at all is refused
    Given the project "chain"
    When nuka runs "run --proof-runs 0 --json"
    Then it stops with "invalid-value"
    And the envelope at "findings" is
      """
      [
        {
          "code": "invalid-value",
          "do": "nuka run --help",
          "fix": "Correct the flag's value as the message says.",
          "message": "--proof-runs must be a whole number of 1 or more (got 0).",
          "severity": "refused"
        }
      ]
      """
