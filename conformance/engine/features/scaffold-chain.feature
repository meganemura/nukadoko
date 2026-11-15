Feature: nuka scaffold writes the steps of a program and the claims on what it returned

  --command <entry point> writes a When step that runs the program in an empty scratch directory and returns its exitCode, stdout, and stderr.
  --request "<METHOD> <path>" writes a When step that sends one request to the program under test and returns its status and body; --body names the args key it sends.
  --then --from <step>.<key> writes a Then step whose one claim compares that earlier step's value with the line's capture.
  The steps these write pass as they are, so a feature about a program runs green with no hand edit.

  Scenario: a --command step and a claim on its output make a feature pass
    Given the project "scaffold-command"
    When nuka runs "scaffold run-greet --pattern 'I run greet with {name:string}' --command greet.*"
    And nuka runs "scaffold the-output-says --pattern 'the output says {text:string}' --then --from run-greet.stdout"
    And nuka runs "run features/greet.feature"
    Then it exits with 0

  Scenario: a --command step returns what the program printed
    Given the project "scaffold-command"
    When nuka runs "scaffold run-greet --pattern 'I run greet with {name:string}' --command greet.*"
    And nuka runs 'do run-greet --args {"name":"Ada"}'
    Then it exits with 0
    And the envelope at "result" is
      """
      {
        "exitCode": 0,
        "stderr": "",
        "stdout": "Hello, Ada!\n"
      }
      """

  Scenario: --argv splits one capture into the program's arguments
    Given the project "scaffold-command"
    When nuka runs "scaffold run-greet --pattern 'I run greet {words:string}' --command greet.* --argv words"
    And nuka runs 'do run-greet --args {"words":"Ada\u0020Lovelace"}'
    Then it exits with 0
    And the envelope at "result.stdout" is
      """
      "Hello, Ada!\n"
      """

  Scenario: --command with no value leaves a TODO that fails by name
    Given the project "scaffold-command"
    When nuka runs "scaffold run-greet --pattern 'I run greet with {name:string}' --command"
    And nuka runs 'do run-greet --args {"name":"Ada"}'
    Then it exits with 1
    And the envelope at "error" is
      """
      {
        "kind": "step_error",
        "message": "fill in the entry point: features/steps/run-greet.*:4"
      }
      """

  Scenario: --command's value names a file
    Given the project "scaffold-command"
    When nuka runs "scaffold run-greet --pattern 'I run greet with {name:string}' --command nope.mjs"
    Then it exits with 2
    And the stop is
      """
      severity: refused
      code: invalid-value
      message: Refusing to scaffold: entry point "nope.mjs" is not a file (looked at nope.mjs); pass the path of the program the step runs, relative to the directory nuka runs in, or give --command no value to leave a TODO
      fix: Correct the flag's value as the message says.
      do: nuka scaffold --help
      """

  Scenario: a --command step is written again with --replace
    Given the project "scaffold-command"
    When nuka runs "scaffold run-greet --pattern 'I run greet with {name:string}' --command greet.*"
    And nuka runs "scaffold run-greet --pattern 'I run greet with {name:string}' --command greet.* --description 'Greet someone' --replace"
    Then it exits with 0
    And it prints
      """
      features/steps/run-greet.*
      """

  Scenario: a step that runs a program is no Then step
    Given the project "scaffold-command"
    When nuka runs "scaffold run-greet --then --pattern 'I run greet with {name:string}' --command greet.*"
    Then it exits with 2
    And the stop is
      """
      severity: refused
      code: invalid-arguments
      message: Refusing to scaffold: --command and --then together; a step that runs a program acts, and a Then step judges through claims
      fix: Correct the command line; the command's --help lists its flags.
      do: nuka scaffold --help
      """

  Scenario: a --request step and a claim on its body make a feature pass
    Given the project "scaffold-request"
    When nuka runs "scaffold get-greeting --pattern 'I request the greeting for {name:string}' --request 'GET /greet/{name}'"
    And nuka runs "scaffold the-response-body-is --pattern 'the response body is {text:string}' --then --from get-greeting.body"
    And nuka runs "scaffold post-the-note --pattern 'I post the note' --request 'POST /echo' --body docstring"
    And nuka runs "scaffold the-echoed-body-is --pattern 'the echoed body is {text:string}' --then --from post-the-note.body"
    And nuka runs "run features/greeting.feature"
    Then it exits with 0

  Scenario: a {key} in the request's path is an args key
    Given the project "scaffold-request"
    When nuka runs "scaffold get-greeting --pattern 'I request the greeting' --request 'GET /greet/{name}'"
    Then it exits with 2
    And the stop is
      """
      severity: refused
      code: invalid-value
      message: Refusing to scaffold: --request's path names {name}, which no capture or --from fills (it has none); a {key} in the path is put in by that args key's value
      fix: Correct the flag's value as the message says.
      do: nuka scaffold --help
      """

  Scenario: --from names a step that returns the key
    Given the project "scaffold"
    When nuka runs "scaffold the-total-is --then --pattern 'the total is {n:int}' --from double.total"
    Then it exits with 2
    And the stop is
      """
      severity: refused
      code: step-inputs-invalid
      message: Refusing to scaffold: double does not return "total"; its keys are doubled
      fix: Add "total" to returns in features/steps/double.* and return total from its run().
      do: nuka scaffold the-total-is --then --pattern 'the total is {n:int}' --from double.total
      """

  Scenario: --from names a step that exists
    Given the project "scaffold"
    When nuka runs "scaffold the-total-is --then --pattern 'the total is {n:int}' --from nope.total"
    Then it exits with 2
    And the stop is
      """
      severity: refused
      code: step-inputs-invalid
      message: Refusing to scaffold: no typed step is named "nope" (`nuka steps` lists the vocabulary)
      fix: Correct the step or the flags as the message says.
      do: nuka scaffold --help
      """

  Scenario: a claim on a chained number compares it with the line's number
    Given the project "scaffold"
    When nuka runs "scaffold the-doubled-is --then --pattern 'the doubled is {n:int}' --from double.doubled"
    And nuka runs 'do the-doubled-is --args {"n":6,"doubled":6}'
    Then it exits with 0
