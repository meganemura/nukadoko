Feature: compat step done-callback form is not supported

  Scenario: a step expecting a done callback fails instead of hanging
    When a legacy step expects a done callback
