Feature: Browser background sharing

  Background:
    Given the browser logs in

  Scenario: whoami after background login
    Then the browser sends the cookie "sid=abc123"

  Scenario: a step that never touches the browser itself
    When the step does nothing with the browser
