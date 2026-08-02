Feature: mixed typed and compat steps share one context

  Scenario: typed and compat steps interoperate in one pickle
    Given a thing is created
    Then the created thing id is read via resultOf
    When a legacy cookie is set
    Then the cookie is visible to a typed request
