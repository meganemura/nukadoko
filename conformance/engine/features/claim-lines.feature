Feature: nuka check judges a claim step from its own file and its line

  A page between two renders can show any state for one frame, so a claim step that observes a page states whether it reads once or until its claims hold.
  A table or docstring that fills a key no claim reads and no observe receives checks nothing, so nuka check reports both before anything runs.

  Scenario: a page read once and a docstring no claim reads
    Given the project "claim-lines"
    When nuka runs "check --json"
    Then it exits with 1
    And the check reports
      """
      error claim-poll-unstated features/steps/heading-says.* Step "heading-says" observes a browser page and does not state poll. Write poll: { timeout_ms } to read until every claim holds on two consecutive readings, or poll: false to read once
      error claim-sentence-unread features/lines.feature:6 Step "kept-note-reads": the docstring of the line fills args.text, which no claim reads, and the step has no observe to receive it, so nothing checks the value the line states. Compare a claim with "text", or take the docstring off the line
      """
