Feature: Fixture teardown

  Scenario: a passing scenario tears its fixture down with outcome passed
    Given a tenant is used

  Scenario: a failing scenario tears its fixture down with outcome failed
    Given a tenant is used and the step fails
