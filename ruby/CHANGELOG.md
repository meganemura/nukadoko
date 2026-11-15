# Changelog

Notable changes to the `nukadoko` gem, the Ruby engine. The npm package has
its own changelog, `../CHANGELOG.md`, and its own versions. Each release's
notes come from the section below whose heading starts with `## [<version>]`.

## [Unreleased]

### Fixed

- An `is-a "url"` claim takes what the TypeScript engine's WHATWG URL
  parser takes: a host or a path in any script (`http://例え.jp/`), `{`, `}`,
  and `|` in a path or a fragment, and extra slashes after the scheme. It
  refuses a port past 65535 and a label that decodes to no letter, which
  Ruby's URI took. Both engines now judge the same texts the same way.

## [0.2.0] - 2026-11-15

### Added

- `Nukadoko.run_command` takes `input:`, the TypeScript engine's name for
  `stdin:`, and `redact:`, the secrets a step holds itself, written as
  `{{secret.NAME}}` in the record while the program gets the real value.
- Env files and secrets, as the TypeScript engine reads them:
  `Nukadoko.config(envFiles: [...])` and an environment's own `envFiles:`
  fill the `env` fixture, with the same parser; a file git does not track,
  or one that differs from HEAD, is a secret source whose values are
  written as `{{secret.NAME}}` in step records, `http.jsonl`, the process
  output files, and what `nuka do` prints, and what a step prints goes to
  stderr with them redacted; `secrets: { public:, redact: }`
  adjusts one key. `nuka check` reports `env-file-missing`,
  `environment-env-file-missing`, `env-file-skipped-line`,
  `secrets-public-key-unknown`, `secrets-redact-key-unknown`,
  `secrets-redact-key-too-short`, and `tracked-secret-looking-key`, and an
  env file that cannot be read stops a command with `env-file-unreadable`.
- `scratch.copy(source)` gives a step a fresh scratch directory that holds
  a copy of a file or directory of the project, as the TypeScript engine's
  does. A missing source raises before any directory is made.
- A step body that names no `args:` keyword (`def run(scratch:)`) is called
  without them, as a TypeScript step that does not read its args; it used
  to fail with `unknown keyword: :args`.
- `nuka run` takes targets: feature files, `file:line` selections (a
  Scenario line or an Examples row), and directories, walked for `.feature`
  files. With none it runs `features/`. A file named twice runs once.
- `nuka run --tag <expression>`, repeatable: `@name` or `not @name`, read
  on the scenario, its Feature line, and its Examples block.
- `nuka run --env <name>`, repeatable. Without it a run starts
  `defaultEnvironments`, else every environment that declares
  `conditions`, else `default`.
- The `--json` envelope of `nuka run` has `selection` (`full` or
  `partial`) and, under `--tag`, `tag_selection`.
- Refusals with the TypeScript engine's codes and exit 2:
  `target-not-found`, `line-on-directory`, `markdown-target`,
  `no-feature-files`, `no-scenario-at-line`, `unknown-environment`,
  `invalid-value` (an expression other than `@name` or `not @name`, or
  `--tag` beside a line target), `invalid-arguments` (an unknown flag),
  and `check-errors`. A `--tag` that keeps no scenario fails with
  `nothing-selected` and exit 1.
- `nuka run` writes `run.json` into the run directory, the `--json`
  envelope as a file, in the TypeScript engine's shape: the commit and
  working tree the run judged, the environments, `counts`, each
  scenario execution with its steps (`step_record_id`, `observed`,
  `error` with its `kind`, `used`, and each claim with `actual_from`,
  `expected_from`, `expected_text`, and `outcome`), and the verdict table
  with each row's `reason`. A failed scenario is a `scenario-failed`
  finding with the `nuka run` line that runs it again.
- `nuka verdict [--json]`: whether the newest run that ended judged the
  working tree as it is now and left nothing red, from run.json and one
  git tree id, without starting a run. It fails with `run-missing`,
  `run-stale`, `run-partial`, the run's own failed findings, or
  `run-failed`, and notes `working-tree-unknown` and `run-without-base`.
  The tree id is the one the TypeScript engine computes, so either engine's
  verdict reads the other's run.
- `nuka run` writes `summary.md` beside `run.json`, rendered from it alone
  in the TypeScript engine's words: the verdict table, each red row's
  reason and where it stopped, what the run does not show (a criterion
  `--env` left out, a skipped check, a held row no control proved, a
  scenario with no claim on a Then line), the conditions, each claim, the
  findings, and the commands that rerun a failed scenario. A scenario with
  no claim on a Then line has `judged_by: "nothing"` in run.json.
- `nuka report [run] --format markdown [--out <file>] [--json]` renders a
  run directory's summary again from its run.json, the newest run when none
  is named.
- `nuka clean [--dry-run] [--json]` removes the run directories and the
  directories an earlier release left under `.nukadoko/`.
- A scenario whose conditions hold in no environment of the run is left
  out and counted in `table.left_out`. When `--env` leaves out every
  selected scenario, the run fails with `nothing-selected` and names a run
  that meets them.
- `nuka run --base <ref>` judges each criterion against the commit `ref`
  names. A criterion is new, changed, unchanged (with `renamed_from` or
  `retagged` when its name or its other tags moved), or removed. A new or
  changed one runs at the base too, the ref's code with head's
  `features/`, where a Then failing in each proof run makes it `proven`
  and anything else `unproven`. An unchanged one runs in the old world,
  head's working tree with the ref's `features/` and config, when the
  mapping under it changed (a file under `features/` other than a
  `.feature`, the config file, or the program file's `conditions` or
  `defaultEnvironments`) or it was renamed or retagged, and is `moved` when
  it does not pass there. Both trees are made under the run directory and
  removed when it ends. `unproven` and `moved` rows are
  `criterion-unproven` and `criterion-moved` findings, run.json's table
  has `base`, `mapping_changed`, and `mapping_changes`, and summary.md
  says what the run compared with and quotes each removed criterion. A ref
  outside git or one that names no commit is refused with
  `base-outside-git`, `base-shallow`, or `base-ref-unknown`.
- `nuka do <step> [--args <json>] [--use <step-id>]...` runs one step
  outside any scenario, in one environment, and writes its step record to
  `.nukadoko/do/<id>/record.json` and stdout, in the TypeScript engine's
  shape. `--use` fills the step's `from` args from an earlier record, of
  a `do` or of a run. A step it does not know is `unknown-step`, args that
  are not a JSON object or do not fit the contract are `step-args-invalid`,
  and a `--use` that names no record is `step-inputs-invalid`.
- `nuka scaffold <name> --pattern <p> [--then] [--description <text>]
  [--replace]` writes a step file whose body raises `not implemented:
  <name>` until it is written, and `nuka scaffold --feature <path>` writes
  one for each line no step matches, its pattern read by
  cucumber-expressions' generator and its name made from the pattern's
  words, in the TypeScript engine's words: the same notes, the same
  commands that write each stub again, and the same refusals
  (`file-exists`, `file-edited`, `invalid-value`, `target-not-found`).
  `--command`, `--request`, and `--from` are refused as not here yet.
- `nuka init` writes `nukadoko.config.rb`, the empty `features/steps/`,
  and the `.gitignore` entries the TypeScript engine writes, refuses with
  `config-exists` when the config file is there, and ends with a
  self-check that loads the config and the steps.
- `nuka check` reports `features-dir-missing` when there is no
  `features/`, and `no-step-files-found` when it holds no step file.
- `nuka check` reports more of the TypeScript engine's findings, in its
  words: a pattern that cannot be read (`unnamed-capture`,
  `unterminated-capture`, `invalid-capture-key`, `duplicate-capture-key`,
  `unknown-parameter-type`, `pattern-syntax-error`),
  `capture-type-mismatch`, `duplicate-pattern`, `then-without-claims`,
  `claims-outside-then`, `condition-tag-malformed`, `condition-unknown`,
  `expects-tag-malformed`, `outline-rows-share-name`, and the vocabulary
  half of `scenario-without-then`. A whole-project check adds the notes
  `pattern-unbound` and `step-description-todo`.
- `nuka check` reports a `from` key whose producer did not run earlier in
  the scenario, or two producers that both did (`from-order-violation`,
  held behind `from-order-check-suppressed` while an earlier line matches
  no step), a table or docstring that fills no single key or a key of the
  wrong type (`table-docstring-key-mismatch`), `fixture-cycle`,
  `fixture-scope-violation`, `condition-unmet`, `outline-does-not-run`,
  and `feature-parse-error`. A whole-project check adds the notes
  `fixture-unused` and `from-unused`. `unfillable-required-key` and
  `undefined-step-check-suppressed` now say what the TypeScript engine
  says.
- `nuka run --order file|shuffled|shuffled:<seed>` plays the feature files,
  then each file's scenarios, in the order the seed names, by the
  TypeScript engine's key, so a seed names one order in either engine. A
  shuffled run prints its seed, writes `order` into run.json, says it in
  summary.md, and names what ran before a failed scenario in its rerun line.
- `nuka run --repeat <n>` plays the selection n times and prints a
  `repeat` line for each scenario that failed at least once.
  `--proof-runs <n>` sets how many runs prove a control, and `--records`
  writes each scenario record to stdout as it ends. A value none of them
  can read is `invalid-value`.
- `nuka run --concurrency <n>` hands whole feature files to n worker
  processes, round robin in the run's order, and runs a file whose
  Feature line has `@nukadoko:serial` after them, alone. A worker that
  ends without a record for a file it was given makes the run
  `run-incomplete`. `nuka check` reports `serial-tag-on-scenario`.
- A program file's `env` is the `env` fixture, and `requireEnv` reads one
  of its keys.

### Changed

- A step with no `returns` keeps nothing of what `run` gives back, so a
  body that ends on a call (`register.set_discount(10)`) passes instead of
  failing inside the engine; a Hash with keys fails with the TypeScript
  engine's message, which names the keys the record would lose. A returns
  failure now reads `returns validation failed:`, as there.
- `nuka check` lists errors, then warnings, then notes, as the TypeScript
  engine does, and `undefined-step` names the patterned steps no line
  binds, so a renamed sentence points at the step it was meant for.
- `nuka init` ends with `next:` naming the gem's `llms.txt`, as the
  TypeScript engine names the package's, and `nuka --help` says its Ruby
  section is how a Ruby step is written.
- `nuka check`'s `undefined-step` reads "No step definition matches" and
  names `nuka scaffold --feature <file>` as its `do:`, as the TypeScript
  engine does, and a project whose every line is undefined no longer also
  gets `no-step-files-found`.
- `nuka init` adds a `scenarios` task that runs `bundle exec nuka run` to
  a Rakefile that has none, and the config file it writes points at the
  spec online, since the gem ships no `docs/`.
- `nuka --help` lists the commands by what they are for (Everyday,
  Exploring, Upkeep), as the TypeScript engine does, and `--version`
  prints the version. A command nuka does not have is refused, pointing at
  `nuka --help`.
- A step definition `nuka check` refuses is named by the step's class
  (`CountMatches claims[0] ...`) instead of `defineStep`, which a Ruby
  step does not have.
- `nuka scaffold` takes `--command [<entry point>]`, `--cwd`, `--argv`,
  `--request "<METHOD> <path>"`, `--body`, and `--from <step>.<key>`, as
  the TypeScript engine does, instead of refusing them. A `--command` step
  runs the program under Ruby in a scratch directory; a `--request` step
  sends through the `request` fixture; a `--then --from` step with one
  capture gets a whole claim. `--replace` knows each of these stubs again.
- `nuka run` prints its progress on stderr as the TypeScript engine does:
  a `scenario i/n` line for each scenario, a `step i/n` line with its
  status and time for each step, a failed step's first error line, the
  producer it used, and its record, then the `steps` line, the counts,
  the control runs, and the criteria. `--json` prints none of it.
- A Then step whose `observe` raises records `unobserved` with each
  claim's `outcome: "unobserved"`, as the TypeScript engine does, instead
  of a `step_error`.
- The `--json` envelope opens with `schema_version` and no longer has
  `engine`, so both engines print the same fields.
- `nuka run` checks only the scenarios it selected, as the TypeScript
  engine does, and a run stopped by `check` exits 2 with `check-errors`.
- Each refusal and each `nothing-selected` finding carries the TypeScript
  engine's message, `fix`, and `do` line. `lib/nukadoko/codes.json` holds
  the TypeScript engine's code registry, and `bin/sync-codes` writes it
  from `nuka check --codes --json`. The text output prints `-` for a
  finding with no place, and each `fix:` line.
- `nuka run --no-check` reports no finding of the check.
- A line no step matches fails with the TypeScript engine's message, `No
  step definition matches "<text>"`.
- A program file whose `environments` declare no `conditions` and that has
  no `defaultEnvironments` runs `default` alone, as the TypeScript engine
  does, rather than every environment.
- A cell's `conditions` in run.json hold only the conditions the row's tags
  name, each with the value the environment declares or `null`, as the
  TypeScript engine writes them.
- Each step record.json `nuka run` writes is in the TypeScript engine's
  shape: `schema_version`, `kind`, `args_origin`, `returns_dropped`,
  the environment, world, run, and scenario it ran in, `evidence`, and
  `observed`. A process `run_command` started is kept with its `group`,
  the `files` it changed under its working directory, its `env`, and its
  stdout and stderr as `process-<n>.stdout.txt` and
  `process-<n>.stderr.txt`, and `run_command` returns `signal` and
  `files` too. What a step changed in a scratch directory is
  `observed.files`, and each claim names the channel its value was
  measured in (`measured`, `expected_measured`). A claim read through a
  view says so in `actual_from` (`as text`). http.jsonl keeps each
  request with its `via`, `duration_ms`, and bodies as text with their
  size, and a page's own requests are not counted as the step's.
- A claim on a literal names the pattern words that state it
  (`literal:accepted`), and a step record lists the project fixtures its
  step used, built (`setup_ms`, `at`) or `reused`.
- Each step gets a W3C trace id, as in the TypeScript engine. A request
  the `request` fixture sends to the world carries a `traceparent`
  (http.jsonl names it, with `declared_url`), and a process
  `run_command` starts gets `TRACEPARENT`. The lines of program.log that
  carry the step's trace id go to `program-log.txt` beside its record
  (`observed.program_log`), and lines that came later to
  `program-log-late.txt`. run.json's `worlds` names each world the run
  started: its URL, commands, timings, log, and what the log held. A
  served world's URL is `http://localhost:<port>`.
- A claim on `each` item is recorded with its declarations, how many
  items there were and were selected, and each judged item, and a claim
  step's failure message is the TypeScript engine's: one line per claim
  that broke, with where two values part under `equal` and
  `has-same-items`, and the item a broken `each` names. The run summary
  writes each claim the same way, and names the record a value was
  measured in when it is another step's.
- A polled claim step's record keeps each reading (`readings`), how many
  there were (`attempts`), and its `settled` conditions with the reading
  it stopped on, and its failure says why the poll stopped. A call a part
  made is recorded as the TypeScript engine records it: `step`, `args`,
  `result` or `error` with its kind, and its times. A step with a page
  lists the Playwright calls it made (`actions`), read from its
  trace.zip, and names the trace in `evidence`. run.json names the steps
  a step used only when it failed.
- A page's documents, fetches, and XMLHttpRequests to the world carry the
  step's traceparent, set through the Chrome DevTools Protocol. A claim
  step that reads a page records what the page had received by the
  judged reading (`pages`, `page_requests`) and what it showed right
  after it (`judged_view`: its title, `judged/page.png`, and
  `judged/page.aria.yml`).
- A request a step sends through Net::HTTP itself is recorded in its
  http.jsonl with `via: "net/http"` and carries the step's traceparent,
  so a claim on what it returned names the channel it was measured in.
  A claim's `measured` reads the value at its `at` path, and a claim
  whose expected value comes from `from` keeps `expected_text: null`.
- Claims are judged with the TypeScript engine's compares: `has-fields`,
  `lacks-field`, `fits-text` (with `...`, `[..]`, and `[..:name]`), and
  `is-a` (with its kinds) are judged now, and a claim whose two sides are
  of two JSON types, or whose expected value every actual holds, breaks
  with the TypeScript engine's `reason`. A claim nothing judged, such as a
  `matches` pattern that ran out of time, is `unjudged`. A broken claim's
  line names the field that does not fit, the field that is present, or
  the line where a text stopped fitting. `nuka check` reports
  `claim-kind-unknown`.
- The gem ships the signature of the whole engine, written by rbs-inline
  from `lib/`'s comments into `sig/generated`, and CI checks `lib/` with
  Steep. A step author's Steep reads the same `Step`, `Schema`, and fixture
  types as before, now from that signature, and `run_command` declares
  `timeout:` and `files:` too.
- `nuka check` reads a claim step's claims against the step that fills each `from` value, as the TypeScript engine does: `claim-path-unknown` for a path its `returns` does not have, `claim-field-stripped` and `claim-args-dropped` for a lacks-field on a key an object schema drops, `claim-not-an-array` for an each on a value that is never an array, and `claim-compares-itself` when both sides read one place.
- `nuka check` reports `claim-poll-unstated` for a claim step whose observe reaches a browser page, directly or through a project fixture, and does not state poll, and `claim-sentence-unread` for a table or docstring that fills a key no claim reads on a step with no observe.
- A step's claims are held to the rules the TypeScript engine's defineStep holds them to, and `nuka check` refuses the first one a step breaks with the same words: a literal no fixed word states, an is-a kind that is none, a key a claim does not have, a view or a count whose compare always breaks, a where clause that selects by the value its claim judges, a capture no claim reads, and the rest.
- A claim can count the items of its actual value (`count: true`) and take its expected value from what observe returned (`expected: { observe: path }`). A claim whose actual starts with a from key reads the value an earlier step returned in a step with observe too, and observe no longer receives the from value such a claim compares with what it read.
- `nuka check` reports, as the TypeScript engine does, a path into an each item its producer does not return, a from path the step's own args drops, a count of a value that is never an array, and an observe that receives the value its claim is compared with.
- A claim on an each item with no actual reads the item itself, and a record keeps an actual value of null.
- `fits-aria-snapshot` is judged as the TypeScript engine judges it: nukadoko takes the ARIA snapshot of the Playwright locator or page observe returns, right after each reading, and a broken claim's line shows the actual lines where the two trees part and names the first expected line that fits nothing and the nearest actual node. `nuka check` reports `claim-aria-snapshot-unreadable` and `claim-aria-snapshot-names-nothing` for a docstring or capture that states a tree no page can be judged on. A step whose claims judge a tree takes no second one into its judged view, and the run summary links each Then's judged view and names the browser the run launched.
- A `judged-as` claim reads its value for a judgment, as the TypeScript engine does: it compares nothing, and the run records the value with the digest a judgment cites (`for-judgment`, `value_digest`). Each row whose Then asks for one gains a `judgment` beside its verdict, read against `judgments/<feature>.json`: `pending` until a judgment cites the value, `judged` or `misses` once one does, `stale` when the value changed since, and `uncitable` when no channel of a step record holds it. A judgment other than `judged` fails the run with `judgment-<state>`, the summary counts and explains each, and under `--base` the run names the judgment files that changed. `nuka judge <file>:<line> [--run <id>] [--json]` shows the values a criterion asks a judge to read, and with `--meets` or `--misses`, `--by`, and `--because` records a judgment of them. A locator or a page is judged as its ARIA snapshot. run.json gains `limits`, and the text output ends with their counts.
- `nuka report --format messages` writes a run as a cucumber-messages stream, as the TypeScript engine does: one test case per execution of a required cell (a control's executions are left out), each claim step's claims as a `claims.json` attachment, each criterion's verdict as a `verdict.json` attachment, and a broken claim as the `nukadoko.ClaimBroken` exception. `nuka run` writes `sources.json` beside `run.json`, so a report reads the run directory alone. A record the report cannot read is the `report-incomplete` finding.
- `nuka report --format allure` writes a run as Allure results, as the TypeScript engine does: one result per execution with one step per line, each claim a child step of its Then, a failure marked with the kind its category in `categories.json` matches, and the history id allure-js-commons computes, so a result keeps the history either engine's results built up. It writes to `.nukadoko/export/allure-results` unless `--out` names another directory, and a render of the same run replaces the files the last one wrote there (the run's `exports` file lists them). A scenario that opened a page keeps a screenshot of it as the scenario ended, `final.png`, under `scenarios/<id>/`, which the result attaches.
- A line more than one step matches is `ambiguous` under `--no-check`, and the steps after it are skipped, as in the TypeScript engine, rather than running the first step that matches. A line no step matches is `undefined`.
- `nuka` reads its files and the Playwright driver's output as UTF-8 under any locale. Under `LANG=C` a browser error message with a non-ASCII character stopped the driver's reader, and the run waited forever.
- `nuka run <feature>:<line> --step` walks one execution of one scenario, pausing after each step until `nuka step` answers, in the TypeScript engine's files, so either engine's `nuka step` answers either engine's walk. `nuka step wait` reports where the walk stands, with a screenshot and an ARIA snapshot of the open page at each pause, and `nuka step next|stop <pause> --walk <n>` answers it. A stop skips the steps after the pause: the scenario is `stopped`, its cell `stopped@<line>`, its row red, and the run fails with `walk-stopped`. A run that selects more than one execution is refused with `step-needs-one-scenario`, another walk in progress with `walk-in-progress`, and an answer to a pause or a walk that is not current with `pause-not-current`, `pause-answered`, or `walk-not-current`. `nuka clean` keeps the run of a live walk, and run.json and the summary say the run was walked.
- `nuka skill path` prints the directory that holds the agent skills, which the gem now ships with `llms.txt`, as the npm package does.
- A control's proof runs come after every scenario of the pass has run
  once, as in the TypeScript engine, rather than right after the control's
  first run.

## [0.1.0] - 2026-11-14

### Added

- The first Ruby engine: steps written as Ruby classes with typed `args` and
  `returns`, `nuka check`, `nuka run`, `nuka steps`, `nuka describe`, and
  `nuka sig` for Steep. It passes every case under `conformance/`.
