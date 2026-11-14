Feature: from with mutually exclusive candidate producers

  Scenario: only the created producer is bound before the consumer
    Given a project "acme" is created
    Then the project is archived

  Scenario: only the imported producer is bound before the consumer
    Given a project "beta" is imported
    Then the project is archived

  Scenario: both producers are bound before the consumer; nuka check errors
    Given a project "acme" is created
    Given a project "beta" is imported
    Then the project is archived

  Scenario: neither producer is bound; the required key errors
    Then the project is archived

  Scenario: neither producer is bound; the optional key stays silent
    Then the project is filed with an optional note

  Scenario: both producers are bound before an optional-key consumer; still errors
    Given a project "acme" is created
    Given a project "beta" is imported
    Then the project is filed with an optional note
