Feature: an accepted scenario is either let go or kept

  # What this pins, before any of it is built: a scenario written from a
  # ticket's acceptance criteria is usually about a change, and a change
  # stops being interesting once it has shipped. Some of those scenarios
  # are not about the change at all, though. They describe the product's
  # own core path, which stays true after the ticket closes, and throwing
  # one of those away costs a guarantee nobody meant to give up.
  #
  # So the decision is not "acceptance or regression" as a property of the
  # tool. It is one question asked once, right after sign-off, about one
  # scenario: does this describe the change, or the product? The answer
  # picks where the feature lives, and nukadoko already has both homes.
  # What it does not yet have is any of the three scenarios below.

  # The choice above is worthless if nobody is told it exists. `nuka
  # accept` currently prints the record's path and stops, which reads as
  # "done" rather than "now decide".
  Scenario: accepting names the choice that follows
    Given a fixture project with a green run of an acceptance feature
    When nuka accept freezes that run
    Then it names where the record landed
    And it names both homes the feature can now live in

  # The negative control for the scenario after it. Silence has to be a
  # property of where the feature lives, not of nuka tend having gone
  # quiet in general, and only a pair of scenarios can show that.
  Scenario: a feature kept for acceptance only is still checked for rot
    Given a fixture project with an accepted feature outside featuresDir
    And that feature has changed since it was accepted
    When nuka tend runs in the fixture project
    Then it reports that the record no longer describes what is on disk

  # The mechanism stating the design: once a feature runs unattended, the
  # guarantee is carried by the run, not by a record frozen at one commit.
  # A record that keeps reporting rot after that is reporting on a claim
  # nothing depends on any more, and an alarm that fires on every ordinary
  # edit is an alarm nobody reads.
  Scenario: a feature kept as regression is not nagged about its sign-off
    Given a fixture project with an accepted feature inside featuresDir
    And that feature has changed since it was accepted
    When nuka tend runs in the fixture project
    Then it reports nothing about that feature's sign-off

  # Reported by a project using this. Two features were made green by one
  # run. Accepting the first wrote its record, which left the tree dirty,
  # which refused the second. Committing that record moved HEAD, which
  # refused the second again for a different reason. The only way through
  # was to run the second feature again, discarding a green run that had
  # already covered it.
  #
  # Both guards are right on their own. What the dirty-tree one protects is
  # the tree the run actually read: a step file, a feature, the config. An
  # acceptance record is none of those. It is what signing off produces,
  # never an input to the run being signed off, so its presence cannot make
  # the claim any less true.
  Scenario: every feature one run made green can be accepted from that run
    Given a fixture project with two acceptance features made green by one run
    When each of them is accepted in turn
    Then both records exist and neither accept asked for the run to be repeated

