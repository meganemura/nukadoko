Feature: done-callback arity is static

  Background:
    Given a user "ada" exists

  Scenario: the background step is enough
    When a step returns pending

  Scenario: a step with no captures expects a done callback
    When a legacy step expects a done callback

  Scenario: a docstring step expects a done callback
    Given a note:
      """
      hello
      """

  Scenario: a table fills the only parameter
    Given these rows:
      | name |
      | ada  |

  Scenario: a capture fills the only parameter
    Given a user "bea" is recorded

  Scenario: a regexp step expects a done callback
    Given a regexp user "ada" exists

  Scenario: two captures are two real parameters
    Given a user "ada" owns 3 items

  Scenario: an ambiguous line is not an arity finding
    Given ambiguous thing
