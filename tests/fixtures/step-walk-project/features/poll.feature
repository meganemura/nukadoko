Feature: A polling page

  Scenario: the polling page is watched
    Given the polling page is open
    When the coupon field is focused
    Then the field "coupon" has the focus
