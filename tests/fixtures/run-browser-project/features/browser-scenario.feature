Feature: Browser background sharing

  Background:
    Given the browser logs in

  Scenario: whoami after background login
    Then the browser sees who is logged in

  Scenario: a step that never touches the browser itself
    Then the step does nothing with the browser
