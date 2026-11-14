Feature: compat hook done-callback form is not supported

  @hook-done-callback
  Scenario: a Before hook expecting a done callback fails instead of hanging
    Given a no-op legacy step runs
