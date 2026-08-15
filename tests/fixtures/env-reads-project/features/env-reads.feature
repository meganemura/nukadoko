Feature: ctx.requireEnv records which names were required

  Scenario: two requireEnv calls, one of them repeated, land on the step record deduplicated and in read order
    Given a step reads two required env vars, one of them twice

  Scenario: a step that never calls requireEnv has no required_env field
    Given a step with no required env reads runs

  Scenario: a step that requires a missing env var still reports the name on its failed step record
    Given a step requires a missing env var

  Scenario: required_env does not bleed across steps sharing one scenario's ctx
    Given step alpha requires its own env var
    Given step beta requires its own env var
