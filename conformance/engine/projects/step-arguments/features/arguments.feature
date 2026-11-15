Feature: arguments

  Scenario: a number reads as JavaScript reads it
    Then the float +.5 reads as "0.5"
    And the integer 007 reads as "7"
    And the decimal 1.50 reads as "1.50"

  Scenario: a word ends at a no-break space
    Then the word a b reads as "a"

  Scenario: a float that is only a sign
    Then the float - reads as "0"
