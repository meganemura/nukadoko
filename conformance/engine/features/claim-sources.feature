Feature: nuka check judges a claim on what an earlier step returned

  A claim step's from value comes from the nearest earlier line that runs its producer, so the producer's returns says what the value can hold.
  A path the returns lack, a lacks-field on a field its object never keeps, an each on a value that is never an array, and two sides that read one place each end one way, so nuka check reports them before anything runs.

  Scenario: four claims that can end only one way
    Given the project "claim-sources"
    When nuka runs "check --json"
    Then it exits with 1
    And the check reports
      """
      error claim-compares-itself features/claims.feature:8 Step "item-itself"'s claims[0] reads item of step "make-item" on line 4 on both sides, so it holds whatever the behaviour is
      error claim-field-stripped features/claims.feature:6 Step "item-no-secret"'s claims[0] is lacks-field "secret" on made, and step "make-item" on line 4 returns that value through an object schema that declares id, name, which drops any key it does not declare, or refuses it as a strict object. secret is never there, so the claim never breaks, whatever the behaviour is
      error claim-not-an-array features/claims.feature:7 Step "tags-short"'s claims[0] reads each item of made, and step "make-item" on line 4 returns a string there, never an array, so the claim never holds, whatever the behaviour is
      error claim-path-unknown features/claims.feature:5 Step "item-colour"'s claims[0].expected.from reads "made.colour", and step "make-item" on line 4 returns nothing at "colour" under item, which has id, name. The value would be undefined, so the claim would always break
      """
