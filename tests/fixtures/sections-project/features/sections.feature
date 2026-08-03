Feature: ctx.section records which stage a step reached

  Scenario: three ctx.section calls land on the receipt in call order
    Given a step with three sections runs

  Scenario: a step that never calls ctx.section has no sections field
    Given a step with no sections runs

  Scenario: a step that fails partway still reports the sections it reached
    Given a step falls in the middle of a section

  Scenario: sections do not bleed across steps sharing one scenario's ctx
    Given step alpha runs its own section
    Given step beta runs its own section
