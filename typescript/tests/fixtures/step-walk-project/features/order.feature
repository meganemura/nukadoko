Feature: An order

  Scenario: an order is placed
    Given a cart with 2 items
    When the order is placed
    Then the cart holds 2 items

  Scenario: an order fails
    Given a cart with 0 items
    When the order is placed
    Then the cart holds 0 items
