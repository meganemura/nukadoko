Feature: nuka init sets up a project

  nuka init writes the config file, the empty steps directory, and the .gitignore entries, naming each path on stdout.
  A config file already there refuses the whole command before anything is written.
  A .gitignore line that already ignores the state directory is kept, and no entry is written twice.

  Scenario: an empty project gets the state directory and env files ignored
    Given the project "bare"
    When nuka runs "init"
    Then it exits with 0
    And the project's file ".gitignore" is
      """
      .nukadoko/
      .env
      .env.*
      !.env.example
      """

  Scenario: nuka check says a project nuka init set up has no step yet
    Given the project "bare"
    When nuka runs "init"
    And nuka runs "check --json"
    Then it exits with 1
    And the findings are "no-step-files-found"

  Scenario: a line that already ignores the state directory is kept
    Given the project "ignored"
    When nuka runs "init"
    Then it exits with 0
    And the project's file ".gitignore" is
      """
      /.nukadoko
      node_modules/
      .env
      .env.*
      !.env.example
      """

  Scenario: a project with a config file is refused
    Given the project "bare"
    When nuka runs "init"
    And nuka runs "init"
    Then it exits with 2
    And the stop is
      """
      severity: refused
      code: config-exists
      message: Refusing to init: <project>/nukadoko.config.* already exists; nothing was written
      fix: Edit the config file that exists, or delete it to start again.
      do: nuka check
      """
