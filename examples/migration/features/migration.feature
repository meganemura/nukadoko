Feature: Migrating a legacy todo suite onto nukadoko, one step at a time

  This suite ships mid-migration on purpose (examples/migration/README.md
  walks through how it got here): most of the glue below is still
  cucumber-js-shaped compat code, imported from "nukadoko/compat" instead of
  "@cucumber/cucumber"; one producer/consumer pair has already been
  promoted to typed steps wired through the resultOf fixture.

  Scenario: legacy glue seeds todos, stashes a note, and asserts the count
    Given a legacy note "seed run" is stashed
    Given the following legacy todos are seeded:
      | title        |
      | Buy milk     |
      | Walk the dog |
    Then the todo list has 2 todos
    And the stashed note reads "seed run"

  Scenario: a promoted producer feeds a typed consumer via resultOf
    Given a todo titled "Read a book" is created
    Then the created todo id is read back via resultOf
