Feature: a Playwright Test suite and nukadoko share one implementation

  # Pins docs/spec.md's "The second door: a Playwright Test suite": sharing
  # works by moving an operation into a plain function over Playwright's
  # own objects, importable from both a spec file and a typed step's `run`,
  # with the contract (zod schemas) living beside it in that same shared
  # file. selftest-suite/fixture-project/playwright-suite/ is that shape,
  # built once and driven three ways below: a real `playwright test`, a
  # real `nuka run`, and a real `nuka do`, all against the one request-based
  # app the fixture starts.

  Scenario: the shared cart helper agrees for a Playwright spec, a nuka run scenario, and a lone nuka do call
    Given the playwright-suite fixture's request server is running
    When the Playwright suite runs against it
    Then the Playwright suite passes
    When nuka run runs the fixture's cart feature against it
    Then that run passes too
    And the add-item step record carries the count the shared helper returned
    When nuka do opens a cart on its own
    Then that step record carries the id the shared helper returned
