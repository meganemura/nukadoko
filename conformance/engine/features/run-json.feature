Feature: nuka run writes run.json, the record of the whole run

  run.json is the --json envelope, written into the run directory.
  It holds the commit and worlds the run judged, the counts, every scenario execution with its steps, and the verdict table.
  A field the engine cannot fill is null, never left out, so a reader finds the same fields from either engine.

  Scenario: run.json holds these fields, for a run with a passing and a failing scenario
    Given the project "chain"
    When nuka runs "run features/chain.feature --json"
    Then it exits with 1
    And it stops with "scenario-failed"
    And the run.json has these fields
      """
      check string
      command string
      commit null
      counts.controls number
      counts.controls_not_run number
      counts.failed number
      counts.not_run number
      counts.passed number
      counts.scenarios number
      counts.stopped number
      environments[].base_url null
      environments[].name string
      environments[].target_version null
      findings[].code string
      findings[].do string
      findings[].file string
      findings[].line number
      findings[].message string
      findings[].severity string
      finished_at string
      nukadoko string
      order.kind string
      run_dir string
      run_id string
      scenarios[].claims.broken number
      scenarios[].claims.held number
      scenarios[].do string
      scenarios[].environment string
      scenarios[].feature string
      scenarios[].finished_at string
      scenarios[].hooks array
      scenarios[].line number
      scenarios[].role string
      scenarios[].scenario string
      scenarios[].scenario_record_id string
      scenarios[].started_at string
      scenarios[].status string
      scenarios[].steps[].attempts number
      scenarios[].steps[].claims[].actual number
      scenarios[].steps[].claims[].actual_from string
      scenarios[].steps[].claims[].compare string
      scenarios[].steps[].claims[].expected number
      scenarios[].steps[].claims[].expected_from string
      scenarios[].steps[].claims[].expected_text string
      scenarios[].steps[].claims[].measured null
      scenarios[].steps[].claims[].outcome string
      scenarios[].steps[].error.kind string
      scenarios[].steps[].error.message string
      scenarios[].steps[].line number
      scenarios[].steps[].mutates boolean
      scenarios[].steps[].observation string
      scenarios[].steps[].observed.files null
      scenarios[].steps[].observed.http null
      scenarios[].steps[].observed.processes null
      scenarios[].steps[].observed.unmeasured array
      scenarios[].steps[].record string
      scenarios[].steps[].status string
      scenarios[].steps[].step string
      scenarios[].steps[].step_record_id string
      scenarios[].steps[].text string
      scenarios[].steps[].used[].record string
      scenarios[].steps[].used[].result.doubled number
      scenarios[].steps[].used[].step string
      schema_version number
      selection string
      started_at string
      table.base null
      table.left_out number
      table.mapping_changed null
      table.mapping_changes null
      table.proof_runs number
      table.rows[].cells[].actuals[].value number
      table.rows[].cells[].claim number
      table.rows[].cells[].conditions object
      table.rows[].cells[].environment string
      table.rows[].cells[].line number
      table.rows[].cells[].outcome string
      table.rows[].cells[].role string
      table.rows[].cells[].runs number
      table.rows[].cells[].world string
      table.rows[].change null
      table.rows[].conditions array
      table.rows[].feature string
      table.rows[].line number
      table.rows[].name string
      table.rows[].reason string
      table.rows[].verdict string
      table.worlds[].environment string
      table.worlds[].world string
      verdict string
      worlds array
      """
    And the run.json at "counts" is
      """
      {
        "controls": 0,
        "controls_not_run": 0,
        "failed": 1,
        "not_run": 0,
        "passed": 1,
        "scenarios": 2,
        "stopped": 0
      }
      """
    And the run.json at "table.rows[1]" is
      """
      {
        "cells": [
          {
            "actuals": [
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
            "runs": 1,
            "world": "head"
          }
        ],
        "change": null,
        "conditions": [],
        "feature": "features/chain.feature",
        "line": 7,
        "name": "the doubled number is not below the bound",
        "reason": "a claim broke at line 9 in default",
        "verdict": "failed"
      }
      """
    And the run.json at "scenarios[1].steps[1].claims" is
      """
      [
        {
          "actual": 12,
          "actual_from": "from:double@8.doubled",
          "compare": "less-than",
          "expected": 10,
          "expected_from": "sentence:bound",
          "expected_text": "10",
          "measured": null,
          "outcome": "broken"
        }
      ]
      """
    And the run.json at "scenarios[1].steps[1].error" is
      """
      {
        "kind": "claim_broken",
        "message": "claim broken: 12 (from:double@8.doubled) less-than 10 (sentence:bound)"
      }
      """
    And the run.json at "scenarios[1].claims" is
      """
      {
        "broken": 1,
        "held": 0
      }
      """

  Scenario: a skipped step has no record, and a step that raises names its error
    Given the project "chain"
    When nuka runs "run features/errors.feature --json"
    Then it exits with 1
    And the run.json at "scenarios[0].steps[2]" is
      """
      {
        "line": 6,
        "record": null,
        "status": "skipped",
        "step": "doubled-is-below",
        "step_record_id": null,
        "text": "the doubled number is below 20"
      }
      """
    And the run.json at "scenarios[1].steps[0].error" is
      """
      {
        "kind": "step_error",
        "message": "too big"
      }
      """
    And the run.json at "scenarios[1].steps[1]" is
      """
      {
        "line": 10,
        "record": null,
        "status": "skipped",
        "step": "doubled-is-below",
        "step_record_id": null,
        "text": "the doubled number is below 10"
      }
      """
    And the run.json at "table.rows[1].reason" is
      """
      "stopped at line 9 in default before a claim there was judged"
      """
    And the run.json at "findings" is
      """
      [
        {
          "code": "scenario-failed",
          "do": "nuka run features/errors.feature:3",
          "file": "features/errors.feature",
          "line": 3,
          "message": "the steps after a broken claim are skipped: claim broken: 12 (from:double@4.doubled) less-than 10 (sentence:bound)",
          "severity": "failed"
        },
        {
          "code": "scenario-failed",
          "do": "nuka run features/errors.feature:8",
          "file": "features/errors.feature",
          "line": 8,
          "message": "a step that raises stops the scenario before its Then: too big",
          "severity": "failed"
        }
      ]
      """
