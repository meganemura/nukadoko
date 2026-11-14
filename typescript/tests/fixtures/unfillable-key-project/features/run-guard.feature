Feature: unfillable-key guard at run time

  Scenario: nothing can fill this required key
    Given a widget is assembled

  Scenario: capture fills the key
    Given a widget named "acme" is captured

  Scenario: from fills the key
    Given a widget source is created
    Given the widget from source is used
