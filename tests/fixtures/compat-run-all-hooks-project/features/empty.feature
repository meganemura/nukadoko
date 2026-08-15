Feature: a feature file with no scenarios at all

  # No Scenario/Scenario Outline below on purpose: selectPickles() (src/run/
  # select-pickles.ts) returns zero pickles for this file: a run that
  # selects no pickles at all must not execute the run-scope hooks.
