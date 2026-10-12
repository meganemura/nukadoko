Feature: capture types against schemas

  Scenario: bad-double-string
    Given bad-double-string 5

  Scenario: bad-long-string
    Given bad-long-string 5

  Scenario: bad-short-string
    Given bad-short-string 5

  Scenario: bad-byte-string
    Given bad-byte-string 5

  Scenario: bad-word-boolean
    Given bad-word-boolean abc

  Scenario: bad-int-boolean
    Given bad-int-boolean 5

  Scenario: bad-anon-number
    Given bad-anon-number abc

  Scenario: bad-int-transform
    Given bad-int-transform 5


  Scenario: bad-bigdecimal-number
    Given bad-bigdecimal-number 5

  Scenario: bad-int-optional-string
    Given bad-int-optional-string 5

  Scenario: ok-int-coerce-string
    Given ok-int-coerce-string 5

  Scenario: ok-int-number
    Given ok-int-number 5

  Scenario: ok-double-number-default
    Given ok-double-number-default 5

  Scenario: ok-word-string
    Given ok-word-string abc

  Scenario: ok-anon-string
    Given ok-anon-string abc

  Scenario: ok-bigdecimal-string
    Given ok-bigdecimal-string 5


  Scenario: ok-int-number-transform
    Given ok-int-number-transform 5

  Scenario: ok-int-preprocess
    Given ok-int-preprocess 5

  Scenario: ok-int-union
    Given ok-int-union 5

  Scenario: ok-int-any
    Given ok-int-any 5

  Scenario: ok-custom-number
    Given ok-custom-number 5

  Scenario: ok-string-coerce-number
    Given ok-string-coerce-number "5"
