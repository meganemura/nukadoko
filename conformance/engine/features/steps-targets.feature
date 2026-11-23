Feature: nuka steps with a target lists the vocabulary of those scenarios

  An agent that edits one scenario reads the steps its lines bind, not the whole vocabulary.
  With a feature file, a file:line, or a directory, nuka steps lists the steps the selected lines bind and the steps those call through parts.
  Each step names the lines that bind it, and a part names the listed steps that call it.
  A line that binds no single step is a finding, and the exit code is 1, because the list leaves out the step that line was meant to bind.

  Scenario: a file lists the steps its lines bind, their parts, and the line nothing binds
    Given the project "steps-targets"
    When nuka runs "steps features/shelf.feature"
    Then it exits with 1
    And it prints
      """
      empty-shelf  typed  mutates
        an empty shelf
        Start with a shelf that holds nothing
        lines: features/shelf.feature:4

      is-below  typed  claims
        {a:int} is below {b:int}
        One number is less than another
        claim: value less-than b
        lines: features/shelf.feature:8

      place-book  typed  mutates
        (no pattern)
        Place one book; a part with no pattern of its own
        part of: shelve-book

      shelve-book  typed  mutates
        a book titled {title:string} is shelved
        Put a book on the shelf, through one part
        lines: features/shelf.feature:7
      error	undefined-step	features/shelf.feature:11	No step definition matches "the shelf is painted"
        do: nuka scaffold --feature features/shelf.feature
      """

  Scenario: a file:line lists the steps of that scenario and its Background
    Given the project "steps-targets"
    When nuka runs "steps features/shelf.feature:6 --json"
    Then it exits with 0
    And the envelope at "steps[1].lines" is
      """
      [
        "features/shelf.feature:8"
      ]
      """
    And the envelope at "steps[2].name" is
      """
      "place-book"
      """
    And the envelope at "steps[2].lines" is
      """
      []
      """
    And the envelope at "steps[2].part_of" is
      """
      [
        "shelve-book"
      ]
      """

  Scenario: a step bound only in another file is left out
    Given the project "steps-targets"
    When nuka runs "steps features/other.feature --json"
    Then it exits with 0
    And the envelope at "steps[0].lines" is
      """
      [
        "features/other.feature:4"
      ]
      """
    And the envelope at "steps[1].lines" is
      """
      [
        "features/other.feature:5"
      ]
      """

  Scenario: a line where no scenario starts is refused
    Given the project "steps-targets"
    When nuka runs "steps features/shelf.feature:5"
    Then it exits with 2
    And stderr holds "no-scenario-at-line"
