Feature: url

  Scenario: texts a browser takes as a URL
    Then the value '"https://example.com/パス"' is a "url"
    And the value '"http://例え.jp/"' is a "url"
    And the value '"http:///example.com"' is a "url"
    And the value '"http://example.com/a{b}#c|d"' is a "url"
    And the value '"http://[::1]:8080/"' is a "url"
    And the value '"http://xn--r8jz45g.例え/"' is a "url"
    And the value '"http://0x7f.1/"' is a "url"

  Scenario: a port past 65535
    Then the value '"http://example.com:99999/"' is a "url"

  Scenario: an IPv4 address with a part past 255
    Then the value '"http://1.2.3.256/"' is a "url"

  Scenario: a label that decodes to no letter
    Then the value '"http://xn--abc.例え/"' is a "url"

  Scenario: no host
    Then the value '"http://user@/"' is a "url"
