Feature: Browser background sharing

  Background:
    Given the browser logs in

  Scenario: whoami after background login
    Then the browser sees who is logged in
