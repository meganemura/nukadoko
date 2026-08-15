Feature: a feature file with no scenarios at all

  # No Scenario/Scenario Outline below on purpose: selectPickles() (src/run/
  # select-pickles.ts) returns zero pickles for this file, the same shape
  # tests/fixtures/compat-run-all-hooks-project/features/empty.feature uses
  # for its own hasPickles gate, reused here to prove the allure emitter is
  # never even constructed for a run that selects nothing.
