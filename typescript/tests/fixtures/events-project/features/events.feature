Feature: What the program did inside each step

  Scenario: reads, writes, jobs, and lines a writer got wrong
    When the client gets "/rooms/7"
    And the client posts to "/scores"
    And the client posts to "/scores?park=1"
    And the client gets "/secret"
    And the client gets "/spliced"
    And the client gets "/late"
    And the step waits
