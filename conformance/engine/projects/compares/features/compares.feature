Feature: compares

  Scenario: fields that fit
    Then the object "{\"id\":1,\"name\":\"a\",\"tags\":[\"x\"]}" has the fields "{\"name\":\"a\",\"tags\":[\"x\"]}"
    And the object "{\"id\":1}" lacks the field "password"
    And the value "\"0190a3b4-5c6d-7e8f-9a0b-1c2d3e4f5a6b\"" is a "uuid"
    And the output "id 7\nready" fits
      """
      id [..:n]
      ...
      """

  Scenario: a field that is missing
    Then the object "{\"id\":1,\"name\":\"a\"}" has the fields "{\"name\":\"a\",\"role\":\"admin\"}"

  Scenario: a list of another length
    Then the object "{\"tags\":[\"x\"]}" has the fields "{\"tags\":[\"x\",\"y\"]}"

  Scenario: an object with no field
    Then the object "{\"id\":1}" has the fields "{}"

  Scenario: a field that is null
    Then the object "{\"password\":null}" lacks the field "password"

  Scenario: a kind that is none
    Then the value "3" is a "thing"

  Scenario: a date that is no day
    Then the value "\"2023-02-29\"" is a "date"

  Scenario: two types
    Then the value "1" equals "\"1\""

  Scenario: a line that fits nothing
    Then the output "id 7\nready\ndone" fits
      """
      id [..]
      waiting
      """

  Scenario: a name that reads two texts
    Then the output "id 7\nagain 8" fits
      """
      id [..:n]
      again [..:n]
      """

  Scenario: a line left over
    Then the output "a\nb" fits
      """
      a
      """
