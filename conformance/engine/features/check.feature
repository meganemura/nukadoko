Feature: nuka check says what is wrong before anything runs

  Each finding names what it is about: a step file, or a feature line.
  A step whose pattern cannot be read binds no line, and nuka check says why in the TypeScript engine's words.
  Only a Then judges, so a claim step elsewhere and a step that runs in Then position are errors.
  A condition or @expects: tag that does not read is an error, and a pattern no line binds alone is a note.

  Scenario: every mistake in the project is a finding
    Given the project "mistakes"
    When nuka runs "check --json"
    Then it exits with 1
    And the check reports
      """
      error ambiguous-step features/mistakes.feature:12 "I go 3" matches more than one step: go-a, go-b
      error ambiguous-step features/mistakes.feature:31 "I go 1" matches more than one step: go-a, go-b
      error ambiguous-step features/mistakes.feature:31 "I go 2" matches more than one step: go-a, go-b
      error capture-type-mismatch features/steps/waited.* Step "waited" pattern "I wait {n:int} seconds" binds key "n" as {int} (a number), but args declares "n" as a string
      error claims-outside-then features/mistakes.feature:4 Step "count-is" declares claims and is bound in When position. Only a Then judges, so a broken claim here would read as a setup that broke (docs/spec.md "Claims")
      error condition-tag-malformed features/mistakes.feature:20 @with: does not read as @with:<condition>, @with:<condition>=<value>, or @without:<condition>, so it names no condition
      error duplicate-capture-key features/steps/paired.* Step "paired" pattern "I pair {a:int} and {a:int}" binds key "a" more than once
      error duplicate-pattern features/steps/go-b.* Multiple patterns normalize to the same text "I go {int}": go-a ("I go {a:int}"), go-b ("I go {b:int}")
      error expects-tag-malformed features/mistakes.feature:25 @expects:bogus does not read as @expects:status=<500-599>, @expects:error=<class>, or @expects:page-error=<name>, so it accepts nothing
      error then-without-claims features/mistakes.feature:9 Step "press" is bound in Then position and runs instead of declaring claims. A Then judges through claims (docs/spec.md "Claims"); a step that only reads or records a value belongs in a Given or When
      error unknown-parameter-type features/steps/painted.* Step "painted" pattern "I paint it {c:color}": This Cucumber Expression has a problem at column 12:

      I paint it {color}
                 ^-----^
      Undefined parameter type 'color'.
      Please register a ParameterType for 'color' This project's registered parameter types are: bigdecimal, biginteger, byte, double, float, int, long, short, string, word.
      error unnamed-capture features/steps/unnamed.* Step "unnamed" pattern "I count {int}": Parameter "{int}" has no name; every parameter in a pattern must be written {key:type} (docs/spec.md "Typed steps")
      error unterminated-capture features/steps/unterminated.* Step "unterminated" pattern "I start {n:int": Pattern has an unterminated "{" starting at: {n:int
      note pattern-unbound features/steps/go-a.* Step "go-a" declares a pattern, but no feature line under the scanned directories (features) binds it. It has no place in any scenario right now.
      note pattern-unbound features/steps/go-b.* Step "go-b" declares a pattern, but no feature line under the scanned directories (features) binds it. It has no place in any scenario right now.
      note pattern-unbound features/steps/never-used.* Step "never-used" declares a pattern, but no feature line under the scanned directories (features) binds it. It has no place in any scenario right now.
      note pattern-unbound features/steps/painted.* Step "painted" declares a pattern, but no feature line under the scanned directories (features) binds it. It has no place in any scenario right now.
      note pattern-unbound features/steps/paired.* Step "paired" declares a pattern, but no feature line under the scanned directories (features) binds it. It has no place in any scenario right now.
      note pattern-unbound features/steps/unnamed.* Step "unnamed" declares a pattern, but no feature line under the scanned directories (features) binds it. It has no place in any scenario right now.
      note pattern-unbound features/steps/unterminated.* Step "unterminated" declares a pattern, but no feature line under the scanned directories (features) binds it. It has no place in any scenario right now.
      note step-description-todo features/steps/todo.* Step "todo" still has the description nuka scaffold wrote ("TODO: describe todo"); nuka steps and nuka describe show it to whoever picks a step, so say what the step does.
      warning outline-rows-share-name features/mistakes.feature:30 Scenario outline "rows that share one name" has 2 Examples rows, and its name uses none of the columns (<n>), so every row is reported under the same name.
      warning scenario-without-then features/mistakes.feature:9 Scenario "a step that runs in Then position" judges no claim: none of its Then lines binds a claim step, so it passes whenever its steps run without an error.
      """

  Scenario: a value no line returns, fixtures that cannot resolve, and a file that does not parse
    Given the project "more"
    When nuka runs "check --json"
    Then it exits with 1
    And the check reports
      """
      error condition-unmet features/more.feature:22 Scenario "conditions no environment meets" needs @with:search @without:search, and no selected environment meets all of them: on (search: true); off (search: false). Its cells would all be controls, so nothing would show that it holds
      error feature-parse-error features/broken.feature Parser errors:
      (6:7): inconsistent cell count within the table
      error fixture-cycle nukadoko.config.* fixture dependency cycle: left -> right -> left
      error fixture-scope-violation nukadoko.config.* fixture "shared" has scope "process" but depends on "store", which is scope "scenario": a "process"-scope fixture is built once for the whole run and can outlive any single scenario's own resources, so it cannot depend on something rebuilt per scenario
      error from-order-violation features/more.feature:19 Step "doubled-is-below"'s from.doubled needs step "double" to have already run earlier in this scenario, but "double" is never bound anywhere in this scenario. This line would fail args validation with certainty
      error from-order-violation features/more.feature:4 Step "doubled-is-below"'s from.doubled needs step "double" to have already run earlier in this scenario, but "double" is never bound anywhere in this scenario. This line would fail args validation with certainty
      error outline-does-not-run features/more.feature:30 Scenario "an outline with no rows" has an Examples table with no rows, so the scenario is left out of the run. Add a row, or remove the table.
      error table-docstring-key-mismatch features/more.feature:17 Step "list-these" has a table/docstring attached but 2 args keys are left unconsumed (a, b); exactly one is required
      note fixture-unused nukadoko.config.* Fixture "left" is declared under nukadoko.config.*'s own `fixtures`, but no typed step requires it, directly or through another fixture. Still reachable through `nuka do`; this is a fact, not a verdict on whether to remove it.
      note fixture-unused nukadoko.config.* Fixture "right" is declared under nukadoko.config.*'s own `fixtures`, but no typed step requires it, directly or through another fixture. Still reachable through `nuka do`; this is a fact, not a verdict on whether to remove it.
      note fixture-unused nukadoko.config.* Fixture "shared" is declared under nukadoko.config.*'s own `fixtures`, but no typed step requires it, directly or through another fixture. Still reachable through `nuka do`; this is a fact, not a verdict on whether to remove it.
      note from-unused features/steps/halve.* Step "halve"'s from.doubled declares a producer, but every bound occurrence of this step already fills "doubled" from a pattern capture. That producer has never supplied it. Still reachable through `nuka do --use`; this is a fact, not a verdict on whether to remove it.
      """
