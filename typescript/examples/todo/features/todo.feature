Feature: Todo list

  Scenario: Adding a todo makes it visible in the list
    Given a todo titled "Buy milk" is added
    Then the todo list includes "Buy milk"

  Scenario: Completing a todo marks it done
    Given a todo titled "Walk the dog" is added
    When the todo titled "Walk the dog" is completed
    Then the todo titled "Walk the dog" is marked done

  Scenario: Adding several todos at once
    Given the following todos are added
      | Water the plants |
      | Read a book      |
    Then the todo list includes "Water the plants"
    And the todo list includes "Read a book"
