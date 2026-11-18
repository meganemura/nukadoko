Feature: missing states

  Scenario: another person signed in
    Given aki signs in
    When ben opens a book

  Scenario: signed out before
    Given aki signs in
    And aki signs out
    When aki opens a book
    And aki opens a book

  Scenario: nobody signed in
    When the reader reads

  Scenario: nothing pays
    Given aki signs in
    When aki opens a book
    And aki pays

  Scenario: a step that names no state ran first
    Given aki waves
    When aki opens a book
