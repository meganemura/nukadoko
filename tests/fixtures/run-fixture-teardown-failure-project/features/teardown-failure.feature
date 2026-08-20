Feature: a fixture whose own teardown fails

  Scenario: the step itself still passes, and the scenario carries its own teardown error
    Given a fixture whose teardown fails is used
