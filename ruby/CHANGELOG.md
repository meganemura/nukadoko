# Changelog

Notable changes to the `nukadoko` gem, the Ruby engine. The npm package has
its own changelog, `../typescript/CHANGELOG.md`, and its own versions.
Each release's notes come from the section below whose heading starts with `## [<version>]`.

## [Unreleased]

### Changed

- **Breaking.** The program's `serve.command` no longer goes through a
  shell: a String is split on whitespace, as in the TypeScript engine, and
  an Array is the words as written. A command that used the shell (`&&`,
  a pipe, a redirect, `VAR=value` in front) is now one program with odd
  arguments. To move: write it as `["sh", "-c", "the same text"]`, or
  move a variable into `env:`.
- **Breaking.** The program is checked before anything starts, and a key
  it does not know is refused (`config-invalid`), with the known key it
  matches when only its case differs: a misspelt `ready` used to leave the
  world ready on any answer from `/`. To move: correct or remove the key
  the message names.
- **Breaking.** A world is ready once `ready` answers 2xx, as in the
  TypeScript engine; any answer counted before, a 404 or a 503 from a
  server still starting included. `serve` takes `timeout_ms` (default
  60000, was a fixed 30 s) and `port` (`"auto"`, the default, or a fixed
  number nothing answers on yet). A program that exits first, or never
  answers 2xx, now fails the run with `program-start-failed` and the end
  of the world's `program.log`, and runs none of that world's scenarios;
  it used to crash the run. To move: point `ready` at a path that answers
  2xx once the program can take requests.
- The gem ships `docs/` beside `skills/` and `llms.txt`, as the npm
  package does, so a finding that cites `docs/spec.md` and a skill that
  links to a document open in the installed gem.
- The bundled skill shows step code on each engine's own pages:
  `skills/nukadoko/references/ruby/` and `references/typescript/` hold the
  same pages under the same headings (step files, claim steps, fixtures,
  the program), an example that names a conformance case copied from it, and
  SKILL.md tells an agent which folder to read from the config file it
  finds. `references/ruby.md`, which translated TypeScript shapes into
  Ruby, is gone, and the worked examples moved to
  `references/typescript/examples/`.

### Fixed

- A program whose `serve` names no `ready` path is ready once `/` answers
  2xx, as in the TypeScript engine. It crashed while it waited for the program.
- A claim's json view reads a text that holds one key twice as
  JavaScript's `JSON.parse` does, keeping the last value, instead of
  refusing it as no JSON.
- `nuka do` starts its world in `world/` beside the record, as the
  TypeScript engine does, so its `program.log` and `{dir}` are there, not
  in the record's own directory.

### Added

- The program's `{events}` placeholder: a served world whose program
  names it gets an empty file outside the run directory, made with mode
  0600 in a directory of its own, and the program appends its execution
  events there. Each step's lines, the ones whose `trace` holds the
  step's trace id, are kept redacted in `events.jsonl` beside its record,
  and its `observed.events` says what they add up to: the lines of each
  kind, the lines that did not read, and whether the work the step sent
  is whole (`whole`, `open`). Once the world stops, run.json's
  `worlds[].events` counts the whole file, the world's redacted copy goes
  beside `program.log`, and a step's lines that arrived after its record
  go to `events-late.jsonl` beside it, named by the step's `events_late`
  (by the record itself, and the `events-late` note, under `nuka do`).
  `{events}` in a world at a `url`, or in a world with neither `serve` nor
  `url`, is `program-placeholder-unfilled`, and every
  `program-placeholder-unfilled` finding now names the edit for its own
  field, as the TypeScript engine's does.
- A claim on a count of an earlier step's execution events:
  `events writes: { of: PlaceScore, count: { kind: "db", op: %w[insert
  update delete other], committed: true } }` names the lines to count,
  a value of which can come from the sentence (`{ sentence: "table" }`),
  and a claim reads the key as its actual. Before it judges its claims,
  the step reads that step's trace from where its slice began, waiting up
  to its `timeout` (10 seconds, or `stepTimeout` when shorter) while the
  events may still become whole, and writes the lines it counted to
  `events-read.jsonl`. The count is a range: a claim holds or breaks only
  when every count in it does, and is `unjudged` otherwise, naming the
  first gap. The record keeps each reading in `events_read`, and the claim
  record carries `actual` or `actual_range`, `counted`, `left_out`, and
  `measured` on `events_read.<key>`. `nuka do --use` reads a recorded step's
  events, and `nuka do` waits for its own step's events before it stops
  its world. `nuka check` reports a selection the format cannot judge, a
  claim that reads inside a count, `events-producer-missing`,
  `events-producer-ambiguous`, `events-inlet-missing`, and
  `events-unread`, and `nuka steps` and `nuka describe` list each key.
  The same as the TypeScript engine.
- A claim step reads the files an earlier step's commands changed:
  `files written: { of: RunBuild, change: "added", under: "src" }` names
  the paths each `Nukadoko.run_command` of that step added, changed, or
  removed, as its record lists them, and a claim reads the key as its
  actual, compared whole or counted. The claim record names the list as
  `files:<step>@<line>` and its `measured` channel in the producer's
  record. `nuka check` reports `files-producer-missing` and
  `files-producer-ambiguous` for a line whose key no single earlier line
  can supply, `nuka do --use` names the record to read, `nuka steps`
  lists each key, and a key that no list could fill is
  `step-file-import-failed`.
- `nuka steps` writes each claim as the TypeScript engine does (`count of`
  a counted claim, `each of` a claim on each item), wraps a long line at
  80 columns, and marks a step that opens a browser.
- A step declares states: `requires` the states a line needs held,
  `gives` the states it leaves held, and `ends` the states it leaves not
  held, each a name or a name and the args key that tells holders apart
  (`requires ["signed-in", :person]`). `nuka check` walks each scenario
  and reports `state-missing` at a line that can only run without its
  state, with the line to add, and `state-shape-mismatch` for a state
  written with a key in one step and bare in another; `nuka run` refuses
  such a scenario before any step runs, `--no-check` included. An entry
  that is no state, and `gives` or `ends` on a claim step, are
  `step-file-import-failed`. `nuka steps` lists each step's states, a
  required one with the steps that give it.
- The program reads `build`, `prepare`, `url`, and `setup`, and an
  environment's `policy` and `version`, as the TypeScript engine does. A
  world runs `build` once per tree, then `prepare`, then `serve` or `url`,
  then `setup`, each under its `timeout_ms`, and run.json names each
  command and phase time. A `url` world is not started and its log is not
  read. `policy: "read-only"` fails a step that declares it mutates, and
  `nuka do` refuses one with `read-only-environment`. `version` goes into
  run.json and every record as `target_version`, and a version that fails
  is the warning `version-probe-failed`. The placeholders `{root}`,
  `{world}`, `{url}`, and `{token}` are filled, and one a world has no
  value for is `program-placeholder-unfilled` in `nuka check`.
- A step can name more than one wording: `patterns "another wording"`
  adds wordings after `pattern`, and `nuka check` reports
  `alias-key-mismatch` when they capture different keys. `nuka steps`
  lists every wording.
- `timeout <ms>` on a step, and `stepTimeout:` in the config (default
  twenty minutes), bound a step's `run` or `observe`. A step past its
  deadline fails with `error.kind` `timeout` and a message naming which
  of the two fired; `nuka steps` shows a step's own timeout.
- `nuka check --fail-on <code>` makes a finding of that code fail the
  check, a note included, and the envelope lists each hit under
  `fail_on_hits`. A code the check never reports, and a note under
  targets, are refused, as in the TypeScript engine. `nuka check --codes`
  lists every code with its meaning without reading the project.
  `lib/nukadoko/codes.json` now records which registry each code comes
  from, and `bin/sync-codes` reads it from
  `typescript/scripts/ruby-codes.ts`.
- `nuka <command> --help` prints that command's usage, what it is for, and
  the flags it reads, and exits 0. A refusal of an unknown flag already
  pointed at it, and until now it did not exist. `docs/engines.json` lists
  each engine's commands and flags, and a conformance case holds that list
  to this help.
- The gem declares itself a [Rails Hyperdrive](https://github.com/rails-hyperdrive/rails-hyperdrive) companion in its metadata (`hyperdrive_targets: "*"`, `hyperdrive_artifacts: skill`). In a Rails app that bundles it, `bin/rails hyperdrive:init` installs the two skills the gem ships to `.claude/skills/nukadoko/` and `.claude/skills/nukadoko-verification/`.
- Each step's record holds its `path`: the requests and the counted kinds of
  its execution events, with the gates of each flag line, as in the
  TypeScript engine.
- When the world stops, a claim on a count of execution events is counted
  again over every line that arrived. A claim judged otherwise then is
  `after_world_stop` on the claim, turns the cell broke, and is a
  `claim-judged-early` finding. run.json's `limits` and the summary now
  list `after-record`, `unrecorded-log`, and `unrecorded-events`, as the
  TypeScript engine does.
- run.json's `flags`: one row per flag and side the steps' execution
  events evaluated, with the criteria that evaluated it, their cells there,
  and the gates their lines named, and the summary's Flags section.
- An `undeclared-write` note: a step that declares `mutates false` and
  whose trace holds a write the program committed to a table that holds
  state.
- The program's `lists`: one command per kind of place (`routes`, `flags`,
  `tables`), each printing one JSON object per line. A world nukadoko
  serves reads them once the program answers. The tables list decides
  which tables a count of writes leaves out, and run.json gains `routes`,
  each world's `lists`, and a `program-list-unread` warning for a list
  that was not read, as in the TypeScript engine.
- run.json's `paths` and the summary's Changed paths: for two
  environments whose conditions differ in one, and under `--base` for the
  base world and head, what each criterion's steps did differently on one
  side, as their execution events report it, with a count a side's missing
  lines could still reach listed as open. Under `--base`, where both
  programs name `{events}`, the base world also runs each row whose head
  cell is required and ran, for its path alone (`for_paths`), so an
  unchanged criterion shows what the code change did to it; the base tree
  is now made for this too when no criterion is new or changed. The same
  as the TypeScript engine.
- A change's intent (docs/intent.md): under `--base`, an `INTENT.md` at
  the repository's top that differs from the base's is read, each row is
  judged against the base pairs of `paths`, and run.json gains `intent`,
  the summary an Intent section, and each difference the row that
  declares it. A difference nothing declares (`intent-unintended`), a row
  that did not happen (`intent-not-happening`), and a file that cannot be
  read (`intent-unread`) fail the run. A writer's own kind counts in a
  path by the fields the rows read on it. The same as the TypeScript
  engine.

## [0.6.0] - 2026-11-17

### Added

- `nuka verdict --trailer` prints one git trailer line,
  `Nukadoko-Verdict: <passed|failed|stale|none|unknown> run <id> tree <id>`,
  to stamp a commit, and exits 0 whatever it says. `--json` carries the
  same line as `trailer`. The same as the TypeScript engine.
- Under `--base`, each judgment a read cites carries `in_base`, and a row
  that stands on a judgment the change added says so in its `judgment`
  limit. The same as the TypeScript engine.

## [0.5.0] - 2026-11-16

### Added

- The fixtures the TypeScript engine gives on ctx and the Ruby engine
  lacked: `context`, `pageAs` (a browser context of its own per name, with
  `trace.<name>.zip` per step and `final.<name>.png` per scenario),
  `section`, `poll` (a block called until it gives a value, kept in
  `polls`), `evidence` (`attach` and `path`, kept in
  `evidence.attachments`), and `resultOf`. Before, `nuka check` accepted
  some of these names and the run then failed with "the Ruby engine has no
  fixture ... yet"; now each name check accepts is one the run gives.
- `base_url:`, `require_env:`, `page_as:`, and `result_of:` name the same
  fixtures as `baseURL:`, `requireEnv:`, `pageAs:`, and `resultOf:`, so a
  step body passes RuboCop's naming cops.
- A step record lists each key `requireEnv` was asked for in
  `required_env`, as the TypeScript engine does. An empty value counts as
  missing.

- A project fixture can name a builtin (`page`, `request`, `env`,
  `requireEnv`, `baseURL`, `scratch`), and one with a builtin's name
  replaces it for every step while its own keyword of that name is the
  builtin, so `Nukadoko.fixture(:page) { |use, page:| ...; use.(page) }`
  wraps the page each step gets. `nuka check` reports `page-override-unowned`
  for a `page` override that names no browser fixture.

- The `request` fixture sends an absolute `https` URL over TLS and works in
  a project with no program, so a step can call a third-party API and keep
  its requests in `http.jsonl`. A path in a world with no URL is refused
  with that reason.

- `args` and `returns` declare what zod declares: `array :todos do ... end`
  for a list of objects, `numbers` and `integers` beside `strings`,
  `array :x, of:` for any item type, `optional: true`, `default:`, and the
  bounds `min:`, `max:`, `positive:`, and `negative:` (and `each:` for an
  array's items). The problems and the JSON Schema `nuka describe` prints
  are zod's. A key `from` fills in some scenarios only can be optional, and
  stays absent where no producer ran.
- The README says how files under `features/steps/` load, so a helper
  module named after its file can be used from any step.

### Changed

- An `integer` field's JSON Schema has the `minimum` and `maximum` zod
  gives `z.int()`.

- `Nukadoko.run_command(..., unbundled: true)` runs the command with the
  environment from before Bundler set up nuka, so `bin/rails runner` in
  another Ruby project loads its own Gemfile instead of nuka's.

- A failed step record whose `error.kind` is `step_error` carries
  `error.at`: the project's own backtrace frames, each `path:line` relative
  to the project root, at most five, redacted like the message. A reader
  finds the line that raised without calling the step again.

### Fixed

- Every command stopped with `NoMethodError` on a feature file that has a
  `Rule:`. The engine now reads the scenarios and the background under each
  rule.
- A page step could wait forever when the run did not start through
  `exe/nuka` and the locale was not UTF-8 (`LANG` unset): the Playwright
  client read the driver's output as US-ASCII and its reader thread died on
  the first non-ASCII byte. The engine sets UTF-8 before it starts the
  driver.

## [0.4.0] - 2026-11-16

### Changed

- The gem accepts `playwright-ruby-client` 1.63.0 and later, in place of
  exactly 1.61.0.

### Fixed

- A step record on a Playwright 1.63 driver had no `actions`: the driver
  writes trace format version 9, which the engine now reads.

### Added

- `Nukadoko.config(parameterTypes: [...])` registers custom parameter types, as
  the TypeScript engine's `parameterTypes` does: each a `name`, a `regexp`
  (a Ruby Regexp or a string), and an optional `transformer` lambda. A step
  can read a value inside a sentence with no spaces around it, such as
  `優先度{priority:priority}のタスクを足す`, without quotes in the feature
  file. A shape the TypeScript schema refuses is `config-invalid` with its
  words. `nuka check` reports `parameter-type-invalid` for a type that takes
  a built-in name or repeats one, `parameter-type-unused` for one no
  pattern names, and `claim-expected-transformed` for a claim that compares
  with a capture a transformer rewrote, which a run under `--no-check`
  leaves unjudged. A run under `--no-check` stops with
  `parameter-type-collision` when the types do not register.

## [0.3.0] - 2026-11-16

### Changed

- **The program moves into the config.** `nukadoko.program.rb` and
  `Nukadoko.program` are gone: the program under test is `program:` in
  `Nukadoko.config`, a lambda that returns the options
  `Nukadoko.program` took, as the TypeScript engine's `program` is. A
  `nuka run --base` compares the config with that lambda cut out, so a
  change to how the program starts is no change to any criterion, and an
  environment's `conditions` and `defaultEnvironments` are compared as
  before. A project root that still holds `nukadoko.program.rb` stops
  every command with `program-file-moved` (exit code 2):

  ```text
  refused	program-file-moved	-	nukadoko.program.rb is no longer read: the program under test is part of nukadoko.config.rb now, so nukadoko does not start what nukadoko.program.rb describes.
    fix: Move what nukadoko.program.rb describes into nukadoko.config.rb as its program, and delete nukadoko.program.rb; CHANGELOG.md, under "The program moves into the config", shows the move.
  ```

  `Nukadoko.program` called from the config is refused with
  `config-invalid`. To upgrade, move the options into the config and
  delete `nukadoko.program.rb`. Before:

  ```ruby
  # nukadoko.program.rb
  Nukadoko.program serve: { command: "bin/rails server -p {port}", ready: "/up" }
  ```

  After:

  ```ruby
  # nukadoko.config.rb
  Nukadoko.config(
    program: -> { { serve: { command: "bin/rails server -p {port}", ready: "/up" } } },
  )
  ```

  Then run `nuka check` until it is green. A `--base` ref from before
  the move needs nothing: the run still reads that ref's program file for
  its base world.

### Fixed

- An `is-a "url"` claim takes what the TypeScript engine's WHATWG URL
  parser takes: a host or a path in any script (`http://例え.jp/`), `{`, `}`,
  and `|` in a path or a fragment, and extra slashes after the scheme. It
  refuses a port past 65535 and a label that decodes to no letter, which
  Ruby's URI took. Both engines now judge the same texts the same way.
- The `text`, `lines`, and `comma-list` views, an `is-a` kind name, and a
  blank expected text trim the spaces JavaScript's trim takes, as the
  TypeScript engine does: a no-break space, an ideographic space, a byte
  order mark, and a line separator. They no longer take a NUL or a next
  line (U+0085). A `comma-list` keeps the empty item after a comma at the
  end, and a docstring that ends in an empty line keeps it in a criterion.
- A screenshot nukadoko takes (a scenario's `final.png`, a judged view's
  `page.png`, and a `nuka run --step` pause's `page.png`) covers in black
  each element that shows a loaded secret, as text or as a field's value,
  as the TypeScript engine does. When those elements are not found within
  5 seconds, no screenshot is written. A judged view and a pause show the
  caret.
- A `--base` run's base and old passes read their env files from head's
  checkout, which holds the ones git ignores, and redact with head's
  secrets as well as the tree's own, as the TypeScript engine does.
- A `matches` claim reads its pattern as JavaScript's `RegExp` does, as
  the TypeScript engine does, and no longer as a Ruby pattern: `^` and `$`
  match only at the ends of the text, `\s` takes every Unicode space, an
  escaped letter with no meaning is the letter (`\A`, `\h`), a `{` that
  starts no count is a `{`, `[^]` takes any character, a backreference to
  a group that did not match matches nothing, `.` takes one UTF-16 unit,
  and a pattern JavaScript refuses (`(?i)`, `a*+`, `(?#...)`) does not
  build, with V8's reason. A lookbehind Ruby cannot run (one of unbounded
  length) is refused with Ruby's reason.
- A `has-item` claim on an array whose items are all `false` or `null`,
  none of them of the expected value's type, breaks with the reason that
  no item is of that type, as the TypeScript engine says, instead of
  simply breaking.
- A step pattern reads its built-in parameter types as the JavaScript
  cucumber-expressions package does, as the TypeScript engine does. A
  `{word}` ends at any Unicode space, so a no-break space no longer joins
  two words. A `{float}` or `{double}` takes the JavaScript pattern and
  reads as `parseFloat` reads it (`1E3` is 1000, a lone sign is NaN). An
  `{int}` past 2**53 is the nearest double, and a `{bigdecimal}` is the
  text as written, not a `BigDecimal`.
- Args and returns that do not fit their schema fail with zod's words, as
  the TypeScript engine's do: `args validation failed: n: Invalid input:
  expected number, received NaN`. Args refuse a key the schema does not
  declare (`(root): Unrecognized key: "x"`), an `unknown` field may be
  missing, an `integer` past 2**53 is too big, and a step with `returns`
  whose `run` gave back nil says so. An arg that is NaN no longer stops the
  run while its step record is written: JSON has no NaN, so the record
  holds null, as JavaScript writes it.
- A claim reads its value as the TypeScript engine reads it. A dotted
  `actual` (`body.user.name`) is a path into what observe returned, not
  one key, and a path that finds nothing breaks the claim with where the
  walk stopped (`observe:value.user.name is undefined, since observe:value
  has nothing at user`) instead of failing the step. A view of a value that
  is no text, and an `at` with nothing there, break the claim with the
  TypeScript engine's reason. A claim that compares a value with itself, or
  with one observe received or computed as a boolean, breaks as there.
- A claim judges a plain JSON copy of each side, as the TypeScript engine
  does: a whole float is the integer JavaScript holds (`2500.0` reads and
  shows as `2500`), an object lists its index keys first, and NaN,
  Infinity, an integer past `Number.MAX_SAFE_INTEGER`, a value of another
  class, a value that holds itself, or one nested past 256 levels leaves
  the claim unjudged with the reason. A step with an unjudged claim fails
  as `claim_unjudged`, as there.
- `nuka run --no-check` refuses to start when a step's declaration is one
  the TypeScript engine's `defineStep` refuses as its file loads, naming
  the first such file, instead of leaving the step out.
- An `each` claim reads its array and each item's paths as the TypeScript
  engine does, with the same reasons when a read finds nothing. It breaks
  when a declaration's expected value is one observe received, and when a
  `where` clause implies an item claim whatever the data (`greater-than 10`
  then `at-least 5`), as there. A poll waits on the outcome the record holds.
- A json view reads its text as JavaScript's `JSON.parse` does and, when
  the text is no JSON, gives V8's reason (`Unexpected token 'a', "a" is not
  valid JSON`, `Expected ',' or '}' after property value in JSON at position
  6 (line 1 column 7)`) instead of Ruby's. A text Ruby's parser takes and
  JavaScript's refuses, such as one with a comment, is refused.
- A refusal or a claim reason quotes a value as JavaScript's
  `JSON.stringify` writes it: a literal written `2.0` reads `2`, and
  `1e20` reads `100000000000000000000`, as in the TypeScript engine's
  text. A json view of a text that holds an unpaired surrogate escape
  (`"\ud800"`), which JavaScript reads and a Ruby string cannot hold, is
  refused with that reason instead of the parser's.

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
