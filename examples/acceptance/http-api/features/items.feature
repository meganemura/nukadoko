Feature: items API

  Acceptance criteria (from the request):
  - POST /items with a name creates the item and answers 201 with its id and name
  - GET /items/<id> answers the item, or 404 with an error for an unknown id
  - A body that is not JSON answers 400; a missing name answers 422
  - GET /items lists every item created so far

  Scenario: creating an item
    When I POST this body to /items
      """
      {"name":"lamp"}
      """
    Then the response status is 201
    And the response body has the name "lamp"
    And the response body has an id of at least 1

  Scenario: reading an item back
    Given an item named "lamp" exists
    When I request that item
    Then the response status is 200
    And the response body is the item that was created

  Scenario: an unknown id
    When I request item 0
    Then the response status is 404
    And the response body is
      """
      {"error":"not found"}
      """

  Scenario Outline: a bad request body: <body> answers <status>
    When I POST this body to /items
      """
      <body>
      """
    Then the response status is <status>
    And the response body is
      """
      {"error":"<error>"}
      """

    Examples:
      | body       | status | error              |
      | not json   | 400    | body is not JSON   |
      | {}         | 422    | name is required   |
      | {"name":""}| 422    | name is required   |

  Scenario: the list holds what was created
    Given an item named "desk" exists
    When I request the item list
    Then the response status is 200
    And the list has the item that was created
