Feature: unfillable required args keys

  Scenario: capture fills the key
    Given a widget named "acme" is captured

  Scenario: table fills the key
    Given a widget batch exists
      | col |
      | x   |

  Scenario: from fills the key
    Given a widget source is created
    Given the widget from source is used

  Scenario: optional key needs nothing
    Given a widget note is filed

  Scenario: nothing can fill this required key
    Given a widget is assembled

  Scenario: compat step is not checked
    Given a compat widget exists

  Scenario: undefined step is not checked
    Given a widget that nobody defined exists

  Scenario: ambiguous step is not checked
    Given an ambiguous widget exists
