Feature: a feature file with no scenarios at all

  # No Scenario/Scenario Outline below on purpose: selectPickles() (src/run/
  # select-pickles.ts) returns zero pickles for this file, the same shape
  # tests/fixtures/compat-run-all-hooks-project/features/empty.feature uses
  # for m22-compat-run-scope's own hasPickles gate — reused here (m3b-allure-
  # emitter spec-b2 task spec, test item 2) to prove the allure emitter is
  # never even constructed for a run that selects nothing.
