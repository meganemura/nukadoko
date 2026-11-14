Feature: BeforeAll's own timeout failure keeps this scenario from ever running

  Scenario: never executes because BeforeAll fails first
    When a no-op step runs
