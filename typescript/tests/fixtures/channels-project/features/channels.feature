Feature: a step's channels are recorded on its step record

  Scenario: a request, a written file, and a command
    Given a step posts to the echo server and keeps what it got

  Scenario: an action nukadoko cannot measure
    Given a step starts a process without runCommand

  Scenario: where each argument came from
    Given an order is created
    When order "blue" ships with the note
      """
      fragile
      """

  Scenario: actions started after their step ended
    Given a step leaves a request and a command for later
    When a step waits
