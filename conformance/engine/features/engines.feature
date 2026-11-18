Feature: docs/engines.json says what each engine offers

  The documents show what each engine has from one table, docs/engines.json.
  The table is a claim about the engines, so it is checked against them: in each world, the commands nuka --help lists and the flags each command's --help names are the ones the table gives that engine.
  A command or a flag one engine gains or loses fails here until the table says so.

  Scenario: the table lists the commands and flags this engine's help names
    Given the project "bare"
    When the help of every command is read
    Then docs/engines.json lists the same commands and flags for this engine
