Feature: a deliberately slow feature, only for watching a live report update mid-run

  # Why this exists, and why its steps are slow on purpose: see
  # features/steps/slow-thing.ts's own header. Do not add this feature's
  # scenario to passing.feature or mixed.feature, and do not speed its
  # steps up -- either change would silently turn the mid-run assertion in
  # selftest-suite/features/steps/allure-watch.ts back into one that only
  # proves a report finishes correct, not that it updates while still
  # running.
  Scenario: four slow things exist, one allure watch poll apart
    Given a slow thing "first" exists
    And a slow thing "second" exists
    And a slow thing "third" exists
    And a slow thing "fourth" exists
