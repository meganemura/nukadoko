Feature: from fills a chained args key

  Scenario: from fills the key when the pattern doesn't capture it
    Given a project "acme" is created
    Then the project is archived

  Scenario: a captured value wins over from
    Given a project "acme" is created
    Then the project "explicit-id" is archived

  Scenario: the upstream hasn't run yet
    Then the project is archived

  Scenario: the upstream ran twice; the most recent result is used
    Given a project "first" is created
    Given a project "second" is created
    Then the project is archived

  Scenario: from and resultOf both read the same upstream; used is deduplicated
    Given a project "acme" is created
    Then the project is closed

  Scenario: the upstream is bound after this line, not before it
    Then the project is archived
    Given a project "late" is created

  Scenario: a captured value needs no upstream at all
    Then the project "no-upstream-id" is archived

  Scenario: an optional from key is silent when its upstream is missing
    Then the project is filed with an optional note

  Scenario: from's injected value is recorded with its result when the reading step fails
    Given a project "acme" is created
    Then the project archival explodes
