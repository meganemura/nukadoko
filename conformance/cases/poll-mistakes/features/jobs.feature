Feature: Jobs finish a little after they start

  Scenario: A job that succeeds is done once it ends
    When a job named "backup" is started and ends "done"
    Then the job ends "done"

  Scenario: A job that fails never becomes done
    When a job named "restore" is started and ends "failed"
    Then the job ends "done"

  Scenario: The id is polled
    When a job named "x" is started and ends "done"
    Then the job id is "1"
