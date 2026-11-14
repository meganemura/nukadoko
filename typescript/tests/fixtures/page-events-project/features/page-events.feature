Feature: Page events

  @expects:page-error=Error
  Scenario: a step's page breaks underneath it
    Given a page logs an error, throws, and calls an unreachable host
