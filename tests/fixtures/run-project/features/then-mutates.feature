Feature: Then mutates violation

  Scenario: a Then step declares mutates true
    Given a thing "widget" exists
    Then a mutating outcome exists
