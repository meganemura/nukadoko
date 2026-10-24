Feature: mixed typed and compat steps share one context

  Scenario: typed and compat steps interoperate in one pickle
    Given a thing is created
    Then the created thing id is "t1" via resultOf
    When a legacy cookie is set
    Then the cookie "sid=abc123" is visible to a typed request
