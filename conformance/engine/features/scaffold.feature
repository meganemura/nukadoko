Feature: nuka scaffold writes a step that fails until someone implements it

  nuka scaffold <name> --pattern writes one step file; --then writes a claim step for a Then line.
  nuka scaffold --feature writes one stub for each line no step matches, reads its pattern from the line, and names it from the pattern's words.
  A stub's body raises "not implemented: <name>", so a run of it fails instead of passing.
  It prints each file it wrote on stdout; notes, and the commands that write each stub again, go to stderr.
  A file it would overwrite is refused, and --replace overwrites it only while it still holds what scaffold wrote.

  Scenario: a stub for each line no step matches
    Given the project "scaffold"
    When nuka runs "scaffold --feature features/tripling.feature"
    Then it exits with 0
    And it prints
      """
      features/steps/i-triple-apples-named.*
      features/steps/a-list-is-posted.*
      features/steps/the-total-is.*
      features/steps/the-note-reads.*
      note: features/tripling.feature:9: the line states its value only with the word "nothing", which fixes 0, "" or [], and no --from names the value it is compared with, so that value's JSON type is unknown; a literal of another JSON type would never hold, so no stub was written; scaffold it alone with --then --from <step>.<key>, naming a value its step's returns declares as z.string(), z.number(), or z.array()
      note: features/tripling.feature:10: a Then step's claim compares what the step reads with a value the line states, and this pattern captures none and holds no word that states one (no, none, nothing, neither, never, empty, once, twice, or a number word from zero to twelve), so no stub was written; state the value this line checks in the line, such as a number or a quoted text, and scaffold again
      next: redo a stub in place with its line below, adding --command, --request, --from, or --description; --replace overwrites the stub while nobody has edited it:
        nuka scaffold i-triple-apples-named --pattern 'I triple {value:int} apples named {value2:string}' --replace
        nuka scaffold a-list-is-posted --pattern 'a list is posted' --replace
        nuka scaffold the-total-is --pattern 'the total is {value:int}' --then --replace
        nuka scaffold the-note-reads --pattern 'the note reads' --then --replace
      """

  Scenario: a stub fails with its args until it is implemented
    Given the project "scaffold"
    When nuka runs "scaffold triple --pattern 'I triple {n:int}'"
    And nuka runs 'do triple --args {"n":4}'
    Then it exits with 1
    And the envelope at "error" is
      """
      {
        "kind": "step_error",
        "message": "not implemented: triple; args {\"n\":4}"
      }
      """

  Scenario: a claim stub observes nothing until it is implemented
    Given the project "scaffold"
    When nuka runs "scaffold tripled-is --then --pattern 'the tripled is {expected:int}'"
    And nuka runs 'do tripled-is --args {"expected":12}'
    Then it exits with 1
    And the envelope at "error" is
      """
      {
        "kind": "unobserved",
        "message": "the step observed nothing, so no claim was judged: not implemented: tripled-is"
      }
      """
    And the envelope at "claims" is
      """
      [
        {
          "actual_from": "observe:actual",
          "compare": "equal",
          "expected_from": "command_line:expected",
          "expected_text": "12",
          "measured": null,
          "outcome": "unobserved"
        }
      ]
      """

  Scenario: a stub scaffold wrote is written again only with --replace
    Given the project "scaffold"
    When nuka runs "scaffold triple --pattern 'I triple {n:int}'"
    And nuka runs "scaffold triple --pattern 'I triple {n:int}'"
    Then it exits with 2
    And the stop is
      """
      severity: refused
      code: file-exists
      message: Refusing to scaffold: features/steps/triple.* already exists, and it still holds what scaffold wrote
      fix: Pass --replace if scaffold wrote the file and nobody edited it, or delete the file.
      do: nuka scaffold triple --pattern 'I triple {n:int}' --replace
      """

  Scenario: --replace writes the stub again
    Given the project "scaffold"
    When nuka runs "scaffold triple --pattern 'I triple {n:int}'"
    And nuka runs "scaffold triple --pattern 'I triple {n:int}' --replace"
    Then it exits with 0
    And it prints
      """
      features/steps/triple.*
      """

  Scenario: --replace leaves a stub someone edited
    Given the project "scaffold"
    When nuka runs "scaffold triple --pattern 'I triple {n:int}'"
    And a line is added to "features/steps/triple.*"
    And nuka runs "scaffold triple --pattern 'I triple {n:int}' --replace"
    Then it exits with 2
    And the stop is
      """
      severity: refused
      code: file-edited
      message: Refusing to scaffold: features/steps/triple.* is not what scaffold writes (someone edited it, or scaffold did not write it), so --replace leaves it
      fix: Delete features/steps/triple.* if it holds no step to keep, then run the same command again; or choose another step name.
      """

  Scenario: a file scaffold did not write is refused
    Given the project "scaffold"
    When nuka runs "scaffold double --pattern 'I double {n:int}'"
    Then it exits with 2
    And the stop is
      """
      severity: refused
      code: file-exists
      message: Refusing to scaffold: features/steps/double.* already exists
      fix: Delete features/steps/double.* if it holds no step to keep, then run the same command again; or choose another step name.
      """

  Scenario: a Then line that states no value gets no claim stub
    Given the project "scaffold"
    When nuka runs "scaffold works --then --pattern 'it works'"
    Then it exits with 2
    And the stop is
      """
      severity: refused
      code: invalid-value
      message: Refusing to scaffold: --then: a Then step's claim compares what the step reads with a value the line states, and this pattern captures none and holds no word that states one (no, none, nothing, neither, never, empty, once, twice, or a number word from zero to twelve)
      fix: Capture the value the line checks in --pattern, such as "the count is {count:int}", or write a feature line with a docstring or a table, and scaffold again.
      """

  Scenario: a step name is kebab-case
    Given the project "scaffold"
    When nuka runs "scaffold Triple --pattern 'I triple {n:int}'"
    Then it exits with 2
    And the stop is
      """
      severity: refused
      code: invalid-value
      message: Invalid step name "Triple": must match [a-z0-9-]+ (kebab-case; it becomes the step's file name)
      fix: Correct the flag's value as the message says.
      do: nuka scaffold --help
      """

  Scenario: a pattern names every capture
    Given the project "scaffold"
    When nuka runs "scaffold triple --pattern 'I triple {int}'"
    Then it exits with 2
    And the stop is
      """
      severity: refused
      code: invalid-value
      message: Refusing to scaffold: Parameter "{int}" has no name; every parameter in a pattern must be written {key:type} (docs/spec.md "Typed steps")
      fix: Correct the flag's value as the message says.
      do: nuka scaffold --help
      """

  Scenario: a feature that every step matches needs no stub
    Given the project "chain"
    When nuka runs "scaffold --feature features/chain.feature"
    Then it exits with 0
    And it prints
      """
      nothing to scaffold: every line in features/chain.feature matches a step
      """

  Scenario: a feature file that does not exist is refused
    Given the project "scaffold"
    When nuka runs "scaffold --feature features/nope.feature"
    Then it exits with 2
    And the stop is
      """
      severity: refused
      code: target-not-found
      message: nuka scaffold --feature: feature file not found: features/nope.feature
      fix: Name a file or a directory that exists.
      do: nuka scaffold --help
      """
