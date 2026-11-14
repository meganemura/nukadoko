Feature: a Before hook declares allure metadata

  @declares-hook
  Scenario: a scenario whose Before hook declares a label and an attachment
    Given a plain step runs under a declaring hook
