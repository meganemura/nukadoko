Feature: Each step's requests carry its trace context

  Scenario: four clients reach the program
    When the step fetches the program
    And the step calls the program through node:http
    And the step asks the program through request
    And the step opens the program's page
