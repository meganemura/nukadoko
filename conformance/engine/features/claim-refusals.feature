Feature: nuka check reports the claims a step may not declare

  A claim the run could judge only one way on every line, or one that lets the line or step code decide what it compares, is refused when the step file loads.
  Both engines refuse it with the same words, so the step leaves the vocabulary before anything runs.
  Each names the step the way its engine writes one: TypeScript as defineStep, Ruby by the step's class.

  Scenario: ten steps whose claims are refused
    Given the project "claim-refusals"
    When nuka runs "check --json"
    Then it exits with 1
    And the check reports
      """
      error step-file-import-failed features/steps/bad-poll.* <step> poll must be false or { timeout_ms, settled? } with a number of milliseconds greater than 0 and at most 2147483647; got {"timeout_ms":0}.
      error step-file-import-failed features/steps/capture-unread.* <step> the pattern captures "price", and no claim reads it, and the step has no observe to receive it, so nothing checks the value the line states. Compare a claim with "price", or take it out of the pattern.
      error step-file-import-failed features/steps/count-matches.* <step> claims[0] counts the items of its actual value, which makes a number, and matches does not compare two numbers, so the claim would break on every line or hold on every line. Compare the count with equal, not-equal, greater-than, at-least, less-than, at-most.
      error step-file-import-failed features/steps/fields-literal.* <step> claims[0].expected is the literal "red", which is never an object, and has-fields compares two objects, so the claim always breaks. Take the expected object from the docstring, read as JSON with expected_view: "json".
      error step-file-import-failed features/steps/lines-has-fields.* <step> claims[0] reads its actual value through view lines, which always makes an array and never an object, so has-fields always breaks. Read the text with view json, or claim a value that is an object.
      error step-file-import-failed features/steps/misspelled-at.* <step> claims[0] has the key "ar", which a claim does not have. It has actual, view, at, count, compare, expected, expected_view.
      error step-file-import-failed features/steps/no-such-kind.* <step> claims[0].expected is the literal "thing", and is-a names one of the kinds string, text, number, integer, boolean, list, array, object, null, uuid, date, timestamp, url, so the claim always breaks. State one of them in the pattern's fixed words.
      error step-file-import-failed features/steps/text-is-string.* <step> claims[0] reads its actual value through view text, which always makes a string, so is-a "string" holds whenever the view applies and states nothing. Name a kind a string may not be, such as uuid, date, timestamp, or url, or claim the value itself.
      error step-file-import-failed features/steps/unstated-literal.* <step> claims[0].expected is the literal "red", and no fixed word of "the colour is shown" states it. Put the value in the sentence, as fixed words or as a capture the claim names.
      error step-file-import-failed features/steps/where-decides.* <step> claims[0].each.where[0] selects by the item at done with equal, and claims[0].each.claims[0] reads the item at done, the same place, so where selects the items by the value the claim then judges and "every item" says nothing. Select by another value, or drop where.
      warning undefined-step-check-suppressed features/steps/bad-poll.* Suppressed 1 undefined-step issue because 10 step files could not be read. undefined-step judgment is on hold until the unreadable glue is fixed
      """
