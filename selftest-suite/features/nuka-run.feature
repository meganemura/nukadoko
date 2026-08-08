Feature: nuka run drives a fixture project

  Scenario: nuka run passes and leaves one allure result file per executed step
    Given a clean copy of the fixture project's nukadoko state
    When nuka run runs "features/passing.feature" in the fixture project
    Then the run exits 0
    And the fixture project's allure-results has one result file per executed step

  # run-selftest.mjs drives both tracks off this one feature file (`nuka
  # run <feature>` only ever takes a single file, never a directory), which
  # is why this scenario lives here rather than in a feature file of its
  # own. It closes the gap docs/spec.md names for the Allure report itself:
  # until now, nothing had opened a `nuka run`-produced Allure report the
  # way an actual reader would (a real HTTP server, a real browser).
  # allure-report.ts's own header explains why that server and browser are
  # required, and why every assertion below reads something data-dependent
  # rather than the report shell's own boilerplate.
  @allure-report
  Scenario: a mixed run's report shows correct counts, groups, attachments, categories, and child steps
    Given a clean copy of the fixture project's nukadoko state
    And the fixture project has nukadoko's own allurerc.mjs
    When nuka run runs "features/mixed.feature" in the fixture project
    And the fixture project's Allure report is generated and opened in a browser
    Then the tab counts match the step statuses nuka run reported
    And every scenario is a tree group and every step is one of its leaves
    And the failing step's receipt.json attachment is readable and matches its own receipt
    And the failing step is categorized as "Step error", not "Product errors"
    And the timeline step's section and poll appear as its own child steps
    And the before-hook-stopped scenario's step shows skipped, not failed
