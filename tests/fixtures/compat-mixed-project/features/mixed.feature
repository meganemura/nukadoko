Feature: mixed typed and compat steps share one context

  Scenario: typed and compat steps interoperate in one pickle
    Given a thing is created
    When the created thing is read via resultOf
    When a legacy cookie is set
    Then the cookie "sid=abc123" is visible to a typed request
