Feature: a step's own result can't reach disk

  Scenario: the general backstop still writes a failed step record and skips the rest
    Given a step returns a value JSON cannot serialize
    Then the thing "unreached" exists
