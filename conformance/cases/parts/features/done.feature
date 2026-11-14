Feature: A step made of parts

  Scenario: A done todo is made from two parts
    Given a done todo titled "Pay rent" exists
    Then the todo titled "Pay rent" is marked done
    And the todo list includes "Pay rent"

  Scenario: A call to a part the step does not declare is refused
    Given a todo titled "Hidden" is added without declaring its part
    Then the todo list includes "Hidden"
