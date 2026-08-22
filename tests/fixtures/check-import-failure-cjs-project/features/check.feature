Feature: a CommonJS project's own .ts step file fails to import

  Scenario: the step is undefined only because its file is .ts in a CommonJS project
    Given a step probed from a .ts file
