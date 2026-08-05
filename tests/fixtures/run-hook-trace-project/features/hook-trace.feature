Feature: Hook trace chunks

  Scenario: hooks and steps each get their own isolated trace chunk
    Given the first step touches the browser
    Then the second step touches the browser
