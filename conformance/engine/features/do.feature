Feature: nuka do runs one typed step alone

  nuka do takes the step's args as a JSON object, starts the world for that one execution, and prints the step record on stdout.
  --use names an earlier step record whose result fills the step's from keys; --args still wins for a key it also sets.
  The record says where each arg came from, and exits 1 when the step failed.
  A command line nuka do cannot carry out is refused on stderr with exit 2.

  Scenario: a step runs with the args the command line gives
    Given the project "chain"
    When nuka runs 'do double --args {"n":3}'
    Then it exits with 0
    And the envelope at "result" is
      """
      {
        "doubled": 6
      }
      """
    And the envelope at "args_origin" is
      """
      {
        "n": "command_line"
      }
      """

  Scenario: a claim step reads its from key from an earlier record
    Given the project "chain"
    When nuka runs 'do double --args {"n":3}'
    And nuka runs 'do doubled-is-below --args {"bound":10} --use <last-step-record>'
    Then it exits with 0
    And the envelope at "args_origin" is
      """
      {
        "bound": "command_line",
        "doubled": {
          "from": {
            "key": "doubled",
            "step": "double",
            "step_record_id": "step-<id>"
          }
        }
      }
      """
    And the envelope at "claims" is
      """
      [
        {
          "actual": 6,
          "actual_from": "from:double@step-<id>.doubled",
          "compare": "less-than",
          "expected": 10,
          "expected_from": "command_line:bound",
          "expected_text": "10",
          "measured": null,
          "outcome": "held"
        }
      ]
      """

  Scenario: a broken claim fails the step
    Given the project "chain"
    When nuka runs 'do double --args {"n":3}'
    And nuka runs 'do doubled-is-below --args {"bound":5} --use <last-step-record>'
    Then it exits with 1
    And the envelope at "error" is
      """
      {
        "kind": "claim_broken",
        "message": "claim broken: 6 (from:double@step-<id>.doubled) less-than 5 (command_line:bound)"
      }
      """

  Scenario: a step that raises fails with its message
    Given the project "chain"
    When nuka runs 'do double --args {"n":1000}'
    Then it exits with 1
    And the envelope at "error" is
      """
      {
        "kind": "step_error",
        "message": "too big"
      }
      """

  Scenario: args the step's schema does not accept fail before it runs
    Given the project "chain"
    When nuka runs 'do double --args {"n":"three"}'
    Then it exits with 1
    And the envelope at "error.kind" is
      """
      "args_invalid"
      """

  Scenario: --args is required when no record gives the args
    Given the project "chain"
    When nuka runs "do double"
    Then it exits with 2
    And the stop is
      """
      severity: refused
      code: step-args-invalid
      message: --args is required unless --use supplies this step's arguments
      fix: Pass --args as a JSON object with the keys that nuka describe <step> lists.
      do: nuka describe double
      """

  Scenario: a step nuka steps does not list
    Given the project "chain"
    When nuka runs 'do triple --args {"n":3}'
    Then it exits with 2
    And the stop is
      """
      severity: refused
      code: unknown-step
      message: Unknown step: triple
      fix: Name a step that nuka steps lists.
      do: nuka steps
      """

  Scenario: a --use that names no record
    Given the project "chain"
    When nuka runs 'do doubled-is-below --args {"bound":5} --use step-missing'
    Then it exits with 2
    And the stop is
      """
      severity: refused
      code: step-inputs-invalid
      message: --use step-missing: no such step record. A step record is removed with its run once the run is older than the newest 20 runs, and a nuka do record once it is older than 7 days (retention in nukadoko.config.*)
      fix: Correct the step or the flags as the message says.
      do: nuka do --help
      """

  Scenario: an environment the program file does not define
    Given the project "chain"
    When nuka runs 'do double --args {"n":3} --env nope'
    Then it exits with 2
    And the stop is
      """
      severity: refused
      code: unknown-environment
      message: Unknown environment "nope": not defined in nukadoko.program.*'s "environments"
      fix: Leave out --env or pass --env default (nukadoko.program.* defines no other environment), or add environments.nope to nukadoko.program.*.
      """
