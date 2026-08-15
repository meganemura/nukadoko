Feature: Inferring fixture needs from a pre-migration step

  Every step under features/steps/ here is un-destructured (`run(ctx, args)`)
  except migrated-ground-truth, its own post-migration twin — none of them
  ever actually run; `nuka steps --json` alone is what this fixture project
  exists for.

  Scenario: a legacy basic step runs
    Given a legacy basic step runs

  Scenario: a migrated ground truth step runs
    Given a migrated ground truth step runs
