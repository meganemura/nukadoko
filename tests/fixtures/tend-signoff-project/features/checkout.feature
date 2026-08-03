Feature: Checkout completes

  Scenario: a shopper checks out
    Given a cart with "3" items exists
    When a legacy discount is applied
    Then the cart total is "27" dollars
