Feature: tasks

  Scenario: a custom type reads a value inside a sentence
    When 優先度高のタスクを足す
    Then 優先度低は"low"と読む
    And 期限は明日である
