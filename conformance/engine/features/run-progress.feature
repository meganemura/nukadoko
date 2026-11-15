Feature: nuka run says on stderr what it ran, as it runs

  Without --json, nuka run writes its progress to stderr: a line for each scenario, numbered across the whole run, a line for each step with its status and its seconds, and for a failed step why it failed and where its record is.
  After the scenarios come where the run wrote, the count of scenarios, the control runs and the criteria when a control makes the count no verdict count, and each failed scenario with the command that runs it again.
  Under --json stderr stays empty, so the envelope is the one thing an agent's shell shows.
  The run's ids and its durations change from run to run, so the progress below reads <run>, <id>, and <s> for them.

  Scenario: a run with a failing claim and a raising step
    Given the project "chain"
    When nuka runs "run"
    Then it exits with 1
    And the progress reads
      """
      scenario 1/4  features/chain.feature:3  the doubled number is below the bound
        step 1/2  passed  <s>  I double 3
        step 2/2  passed  <s>  the doubled number is below 10
      scenario 2/4  features/chain.feature:7  the doubled number is not below the bound
        step 1/2  passed  <s>  I double 6
        step 2/2  failed  <s>  the doubled number is below 10
            claim broken: 12 (from:double@8.doubled) less-than 10 (sentence:bound)
            record  .nukadoko/runs/<run>/steps/<id>
      scenario 3/4  features/errors.feature:3  the steps after a broken claim are skipped
        step 1/3  passed  <s>  I double 6
        step 2/3  failed  <s>  the doubled number is below 10
            claim broken: 12 (from:double@4.doubled) less-than 10 (sentence:bound)
            record  .nukadoko/runs/<run>/steps/<id>
        step 3/3  skipped  <s>  the doubled number is below 20
      scenario 4/4  features/errors.feature:8  a step that raises stops the scenario before its Then
        step 1/2  failed  <s>  I double 1000
            too big
            record  .nukadoko/runs/<run>/steps/<id>
        step 2/2  skipped  <s>  the doubled number is below 10
      steps     .nukadoko/runs/<run>/steps/  7
      summary   .nukadoko/runs/<run>/summary.md
      run       .nukadoko/runs/<run>/run.json
      4 scenarios: 1 passed, 3 failed  (<s>)
      failed	scenario-failed	features/chain.feature:7	the doubled number is not below the bound: claim broken: 12 (from:double@8.doubled) less-than 10 (sentence:bound)
        do: nuka run features/chain.feature:7
      failed	scenario-failed	features/errors.feature:3	the steps after a broken claim are skipped: claim broken: 12 (from:double@4.doubled) less-than 10 (sentence:bound)
        do: nuka run features/errors.feature:3
      failed	scenario-failed	features/errors.feature:8	a step that raises stops the scenario before its Then: too big
        do: nuka run features/errors.feature:8
      """

  Scenario: a run over two environments, one of them a control
    Given the project "switch"
    When nuka runs "run"
    Then it exits with 0
    And the progress reads
      """
      environment on
      scenario 1/4  features/switch.feature:4  a criterion whose control passes too
        step 1/1  passed  <s>  1 is below 10
      scenario 2/4  features/switch.feature:7  a criterion for every environment
        step 1/1  passed  <s>  2 is below 10
      environment off
      scenario 3/4  features/switch.feature:4  a criterion whose control passes too  (control)
        step 1/1  passed  <s>  1 is below 10
      scenario 4/4  features/switch.feature:7  a criterion for every environment
        step 1/1  passed  <s>  2 is below 10
      steps     .nukadoko/runs/<run>/steps/  4
      summary   .nukadoko/runs/<run>/summary.md
      run       .nukadoko/runs/<run>/run.json
      3 scenarios: 3 passed, 0 failed  (<s>)
      1 control run
      criteria: 2 held, 0 proven, 0 failed
      limits: 1 control-not-proving (run.json limits)
      """

  Scenario: under --json stderr is empty
    Given the project "chain"
    When nuka runs "run --json"
    Then it exits with 1
    And the progress reads
      """
      """
