Feature: reads

  Scenario: a path reads inside the value, and a whole number is one number
    Then the name-field of '{"user":{"name":"aki"}}' is "aki"
    And the whole-value of '{"b":2.0,"0":1}' is '{"0":1,"b":2}'

  Scenario: a path whose last key is missing
    Then the name-field of '{"user":{}}' is "aki"

  Scenario: a path that stops before its last key
    Then the name-field of '{}' is "aki"

  Scenario: an at with nothing there
    Then the first-tag of '{"tags":[]}' is "a"

  Scenario: a view of a value that is no text
    Then the text-start of '{"a":1}' is "a"

  Scenario: an integer JavaScript cannot hold exactly
    Then the whole-value of '[100000000000000000000]' is '[1]'

  Scenario: each reads a path inside every item
    Then every row of '{"rows":[{"user":{"name":"aki"}},{"user":{"name":"aki"}}]}' names "aki"

  Scenario: an item whose path stops early
    Then every row of '{"rows":[{"user":{"name":"aki"}},{"user":{}}]}' names "aki"

  Scenario: a where clause that implies the item claim
    Then every row of '{"rows":[{"score":12}]}' with a score over 10 scores at least 5
