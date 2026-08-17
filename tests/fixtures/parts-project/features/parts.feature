Feature: a part's own mutates is checked under a read-only environment

  Scenario: a mutates: false composite calling a mutates: true part is refused
    When a mutates: false composite calls a mutating part
