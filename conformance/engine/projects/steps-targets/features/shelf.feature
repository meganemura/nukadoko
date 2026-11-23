Feature: a shelf

  Background:
    Given an empty shelf

  Scenario: a book is shelved
    When a book titled "Dune" is shelved
    Then 1 is below 10

  Scenario: a line nothing binds
    When the shelf is painted
