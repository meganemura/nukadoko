Feature: a step's own timeout overrides setDefaultTimeout

  Scenario: passes because its own (larger) timeout wins over the small default
    Given a legacy step whose own timeout overrides the default and sleeps briefly
