Feature: nuka run drives a fixture project

  # Stage 1: the scaffold itself. This scenario is the only one below with no
  # tag and no browser -- it proves the two tracks agree on the basic case
  # before any of the later, more specific scenarios (stage 2 = @allure-report,
  # stage 3 = @allure-watch, stage 4 = @allure-browser, one steps file each)
  # build on it.
  Scenario: nuka report renders one allure result file per scenario of a run
    Given a clean copy of the fixture project's nukadoko state
    When nuka run runs "features/passing.feature" in the fixture project
    Then the run exits 0
    When nuka report renders the newest run as Allure results in the fixture project
    Then the fixture project's allure-results has one result file per scenario

  # run-selftest.mjs drives both tracks off this one feature file (`nuka
  # run <feature>` only ever takes a single file, never a directory), which
  # is why this scenario lives here rather than in a feature file of its
  # own. It closes the gap docs/spec.md names for the Allure report itself:
  # until now, nothing had opened a rendered Allure report the
  # way an actual reader would (a real HTTP server, a real browser).
  # allure-report.ts's own header explains why that server and browser are
  # required, and why every assertion below reads something data-dependent
  # rather than the report shell's own boilerplate.
  @allure-report
  Scenario: a mixed run's report shows correct counts, tree leaves, attachments, categories, and child steps
    Given a clean copy of the fixture project's nukadoko state
    And the fixture project has nukadoko's own allurerc.mjs
    When nuka run runs "features/mixed.feature" in the fixture project
    And nuka report renders the newest run as Allure results in the fixture project
    And the fixture project's Allure report is generated and opened in a browser
    Then the tab counts match the scenario statuses nuka run reported
    And every scenario appears as its own tree leaf
    And the failing step's record.json attachment is readable and matches its own record
    And the failing step is categorized as "Step error", not "Product errors"
    And the timeline step's section and poll appear as its own child steps
    And the before-hook-stopped scenario's step shows skipped, not failed
    And the before-hook-stopped scenario itself shows failed, not skipped

  # Stage 3: `allure watch` started before the run, as README and
  # docs/spec.md say it can be. The run itself writes nothing into
  # allure-results, so the live report still reads 0 once it has finished;
  # it changes only when `nuka report` renders the run there.
  # features/steps/allure-watch.ts's own header explains why no step here
  # ever calls `.goto()`/`.reload()`.
  @allure-watch
  Scenario: allure watch shows a run once nuka report renders it, and nothing before
    Given a clean copy of the fixture project's nukadoko state
    And allure watch is running on the fixture project's empty allure-results
    And the live report is open in a browser
    Then the live report shows 0 results before any run starts
    When nuka run runs "features/passing.feature" in the fixture project
    Then the run exits 0
    And the fixture project's allure-results holds no result file
    When nuka report renders the newest run as Allure results in the fixture project
    Then the fixture project's allure-results has one result file per scenario
    And the live report's final result count matches the number of scenarios

  # Stage 2 read a finished report and stage 3 watched one update live, but
  # neither one ever launched a browser inside the run under test itself --
  # every fixture step both of those exercised was a pure step. 0.1.0's own
  # Playwright-native redesign left a browser-driven run's evidence
  # (README, docs/spec.md) in four places a report reader can open: a trace
  # per step and per hook, that trace's own calls as child steps
  # ("actions"), `page_events` counts as parameters, and a hook that
  # touches the browser showing up as its own fixture. None of the four had
  # ever been opened on screen before this scenario. Kept in a feature of
  # its own in the fixture project
  # (browser-evidence.feature), never mixed into passing.feature or
  # mixed.feature, so stage 1 through stage 3 above keep
  # launching zero browsers and keep their existing runtime.
  # allure-browser-evidence.ts's own header explains the two chromiums this
  # scenario's own steps must never confuse.
  @allure-browser
  Scenario: a browser-driven run's trace, hook, action, and page-event evidence all show up in the report
    Given a clean copy of the fixture project's nukadoko state
    When nuka run runs "features/browser-evidence.feature" in the fixture project
    Then the run exits 0
    When nuka report renders the newest run as Allure results in the fixture project
    And the browser-evidence report is generated and opened in a browser
    Then the step's own trace attachment downloads as a non-empty, readable zip
    And the before hook shows up as a fixture in the report
    And the trace's own goto action appears as a child step
    And the page_events counts in the report match the step's own record
