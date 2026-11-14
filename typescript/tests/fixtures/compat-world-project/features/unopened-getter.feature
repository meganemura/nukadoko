Feature: World unopened getter

  Scenario: accessing this.page before openPage() resolves fails clearly
    Then the unopened page getter is accessed

  Scenario: attach/log/link are received without crashing
    Then attach, log, and link are all callable without crashing
