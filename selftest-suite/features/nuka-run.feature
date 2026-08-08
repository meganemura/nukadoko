Feature: nuka run drives a fixture project

  Scenario: nuka run passes and leaves one allure result file per executed step
    Given a clean copy of the fixture project's nukadoko state
    When nuka run runs "features/passing.feature" in the fixture project
    Then the run exits 0
    And the fixture project's allure-results has one result file per executed step
