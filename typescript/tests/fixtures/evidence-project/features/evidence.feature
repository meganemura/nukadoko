Feature: evidence.attach / evidence.path let a step add its own evidence

  Scenario: attach() writes and lands on the step record with at
    Given a step attaches orders.json

  Scenario: the same name attached twice keeps both files
    Given a step attaches the same name twice

  Scenario: path() alone, unwritten, is omitted from the step record
    Given a step allocates a path but never writes to it

  Scenario: path() followed by a real write lands on the step record
    Given a step writes to its own allocated path

  Scenario: path() twice with the same name returns two different paths
    Given a step allocates a path twice with the same name

  Scenario: an unsafe name is refused
    Given a step attaches with a name that tries to escape the evidence directory

  Scenario: more attachments than the cap allows
    Given a step attaches more than the cap allows

  Scenario: a secret-derived name is redacted
    Given a step attaches a name built from a secret

  Scenario: evidence does not bleed across steps sharing one scenario's ctx
    Given step alpha attaches its own evidence
    Given step beta attaches its own evidence
