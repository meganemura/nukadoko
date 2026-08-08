Feature: a browser-driven scenario, so its trace/hook/action/page-event evidence can be read in a real report

  # Kept apart from passing.feature, mixed.feature, and slow.feature on
  # purpose (selftest-browser task spec, decision 3): this is the only
  # fixture-project feature whose own step and Before hook launch a
  # browser. Nothing else in this project may join it here -- doing so
  # would make selftest-suite's stage 1 through stage 3 scenarios launch a
  # browser too, and this task's spec forbids slowing those down even by a
  # second.
  @browser-evidence
  Scenario: a step and its own Before hook both touch the browser
    Given the browser visits a data url that logs, throws, and fails a request
