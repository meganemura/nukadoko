Feature: Playwright's own files are not the step's

  Scenario: a page and a request
    Given the page is opened and its button pressed
    Then the request fixture reaches the api
