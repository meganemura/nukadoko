Feature: what failed underneath the steps

  Scenario: nobody expects the outage
    When the shop is asked at "/ask/down"
    Then the shop answered 1 time

  @expects:status=503
  Scenario: the outage is expected
    When the shop is asked at "/ask/down"
    Then the shop answered 1 time

  Scenario: nobody expects the error
    When the shop is asked at "/ask/boom"
    Then the shop answered 1 time

  @expects:error=Boom
  Scenario: the error is expected
    When the shop is asked at "/ask/boom"
    Then the shop answered 1 time

  Scenario: a caught error is no failure
    When the shop is asked at "/ask/caught"
    Then the shop answered 1 time

  @expects:status=503
  Scenario: the outage no longer happens
    When the shop is asked at "/ask/ok"
    Then the shop answered 1 time

  Scenario: nobody expects the page to throw
    When the shop page is opened at "/page/throw"

  @expects:page-error=TypeError
  Scenario: the page throws as expected
    When the shop page is opened at "/page/throw"

  Scenario: the page's own request fails
    When the shop page is opened at "/page/down"

  @expects:status=503
  Scenario: a page of a named context sends the step's trace context too
    When aki opens the shop page at "/page/down"
