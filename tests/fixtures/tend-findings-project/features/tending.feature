Feature: Tending findings

  Scenario: bind every step this fixture needs bound
    Given a widget "Widget A" is created
    And the widget is finalized
    And the widget "w_0001" is inspected
    And a shout abc is heard
    And a low note is logged
