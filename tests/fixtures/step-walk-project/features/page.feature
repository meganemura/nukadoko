Feature: A page

  Scenario: the cart page is shown
    Given the cart page is open
    When the coupon field is focused
    Then the field "coupon" has the focus
