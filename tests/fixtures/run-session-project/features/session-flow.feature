Feature: Session propagation across scenarios

  Scenario: first scenario sets a cookie
    Given a cookie is set via request

  Scenario: second scenario reads the cookie
    Then the cookie is visible via request
