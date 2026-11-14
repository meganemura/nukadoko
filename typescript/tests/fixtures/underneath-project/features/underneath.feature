Feature: A program that fails underneath its steps

  Scenario: a page that answers 500
    When the client gets "/broken"
    Then the program answered 500

  Scenario: a request whose error the program did not handle
    When the client gets "/stale"
    Then the program answered 200

  Scenario: a request whose error the program caught
    When the client gets "/rescued"
    Then the program answered 200

  @expects:status=500 @expects:error=Boom::Exploded
  Scenario: a page that answers 500 on purpose
    When the client gets "/broken"
    Then the program answered 500

  @expects:status=503
  Scenario: a maintenance page
    When the client gets "/down"
    Then the program answered 503
