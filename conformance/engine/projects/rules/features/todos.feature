Feature: todos

  Rule: a todo starts open

    Background:
      Given a list named "chores"

    Scenario: a new todo is open
      When a todo "sweep" is added
      Then the todo "sweep" reads "open"

  Rule: a done todo stays done

    Scenario: a done todo reads done
      When a todo "dust" is added done
      Then the todo "dust" reads "done"
