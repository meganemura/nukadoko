Feature: Checkout

  Scenario: an empty cart
    Given a cart with 0 items
    Then the cart holds 0 items

  Scenario Outline: a cart with items
    Given a cart with <count> items
    Then the cart holds <count> items

    Examples:
      | count |
      | 1     |
      | 3     |
