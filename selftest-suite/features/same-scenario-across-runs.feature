Feature: the same scenario is recognised from one run to the next

  # What this pins: a scenario that runs more than once has a history, and
  # a reader should be able to see it. That was given up when the Allure
  # output moved to one test per step, because a step has nothing about it
  # that stays the same across runs: its text collides with other steps'
  # text, its position moves when anything above it is edited, and counting
  # occurrences cannot tell an inserted duplicate from the original. Rather
  # than link two different steps as one, nothing was linked at all.
  #
  # The grain was the mistake, not the goal. A scenario does have a stable
  # identity, and "did this break recently" is a question about a scenario
  # anyway. What is pinned here is the capability, not the mechanism: these
  # scenarios say nothing about what the identity is made of, only that two
  # runs of the same thing are recognised as the same thing, and that two
  # different things are never mistaken for one.

  Scenario: a scenario that passed and then failed reads as a regression
    Given a fixture project whose report keeps its history
    When the same feature runs twice, green and then red
    Then the report marks that scenario as regressed from its own last run

  Scenario: a scenario that failed and then passed reads as fixed
    Given a fixture project whose report keeps its history
    When the same feature runs twice, red and then green
    Then the report marks that scenario as fixed from its own last run

  # The measured failure mode this whole capability has to survive. Two
  # Examples rows share a feature path and a scenario name and differ only
  # in their values; an identity built from name alone folds them into one
  # and reports the second row as a retry of the first. Being silent was
  # chosen over being wrong once already, so anything that restores the
  # link has to clear this before it is worth having.
  Scenario: two rows of one Scenario Outline are never treated as one
    Given a fixture project whose report keeps its history
    When a Scenario Outline with two rows runs once
    Then the report counts two scenarios, neither one a retry of the other
