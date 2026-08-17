# Changelog

Notable changes to nukadoko. Versions follow [Semantic Versioning](https://semver.org/),
with one caveat stated in the README: while this is 0.x, the public API can
change in any release. That holds for the whole 0.x range, up to 1.0, not
just until 0.1.

## 0.5.0 — 2026-08-17

### Added

- **A step can call another step, so a step can be split without its
  feature file being rewritten.** `defineStep` takes `parts`, the list of
  steps this one's `run` may call, and the new `call` fixture runs one:
  `const project = await call(createProject, { name: args.name })`. There
  is no new kind of unit here. A part is an ordinary step, usually one
  defined without a `pattern`, which was already complete CLI-only
  vocabulary that `nuka do` runs and `nuka steps` lists; what was missing
  was a way to call one. What makes it worth having is what it leaves
  alone. The calling step keeps its pattern, its `args`, and its
  `returns`, so a scenario that was agreed with the people who decide
  what the software is for, and that may already carry a sign-off, stays
  as it is while the implementation underneath is split in two. Giving
  that same part a `pattern` later binds it as a scenario line of its own
  without taking it away from the step that calls it, which is how a
  second scenario gets half of an existing step without the first
  scenario paying for it. `parts` is declared rather than read out of the
  body because a step's fixture bag is built before `run` is called: a
  step's needs are now its own destructured names together with every
  part's, closed transitively, so a composite whose part reaches for
  `page` opens a browser. Reading `call` sites out of a body instead
  would be a parser guessing at control flow, and the guess would be
  wrong on exactly the calls that sit inside a branch. `call` refuses a
  step `parts` does not list, and refuses one discovery never registered,
  which is the mistake `ctx.resultOf` already throws on.
- **A step record carries `calls`**: one entry per part this execution
  ran, with the part's name, the args it was given, the result it
  returned, when it started and finished, and its own error when it
  failed. A part that called a part nests under that entry. These are not
  step records and carry no `step_record_id`. A scenario record's
  `steps[]` stays one entry per feature line, because a feature that does
  not name everything that ran stops being the record this tool exists to
  keep; what a part adds is depth under one of those lines. Everything
  measured stays at the step boundary as well: `observed`, `sections`,
  `used`, `required_env`, the evidence directory, and the trace are the
  calling step's, and count the parts' work inside their own totals, so
  nothing is counted twice and nothing that ran goes uncounted because it
  ran inside a part.
- **`nuka steps --json` and `nuka describe` show `parts`**, so an agent
  reading the vocabulary can see that one step is built out of others
  without opening a file, the same reason `from` is already there. `nuka
  steps`' one-line-per-step text listing is unchanged: it stays readable
  in one screen however large the vocabulary grows. A step's `needs` and
  `needs_browser` now account for its parts too, since the bag its parts
  will destructure from is the one the composite is given.
- **The Allure emitter nests a `calls` entry as a nested step** under the
  step that called it, carrying the part's args and result as parameters,
  through the reporter machinery's own nesting rather than a shape
  invented here.
- **`nuka check` gains three findings about `parts`**, all of them things
  it can be certain of without running anything.
  `part-structural-violation` names an entry that is not a `Step`, or one
  discovery never registered. `part-cycle` names a step that reaches
  itself, which can never close into a fixture bag or a terminating run.
  `part-mutates-contradiction` names a step declaring `mutates: false`
  while declaring a part that declares `mutates: true`, since `mutates`
  covers everywhere the step touches and a part it may call is part of
  that reach. That last one is also what keeps `then-mutates` reading a
  single flag on a single step instead of walking a graph. A declared
  part the body never calls is reported by nothing, on purpose: the call
  is inside `run` while the declaration names a `Step` object, so
  matching them would be a guess about an identifier, and a check that
  guesses costs more than the silence it replaces.
- **A read-only environment now refuses a `mutates: true` part**, at the
  call, before it runs, whatever the calling step declared about itself.
  Only the entry step's own flag was checked before, so a composite
  declaring `mutates: false` while calling a mutating part could reach
  the wire under a read-only policy. The static contradiction check above
  catches the same mistake earlier and more cheaply; this is what holds
  when nobody ran `nuka check`.

## 0.4.1 — 2026-08-16

### Changed

- **`skills/acceptance/SKILL.md` now opens with a staged entry point
  instead of assuming a scenario is already in hand.** A reader can start
  from raw prose with no stated acceptance criteria yet, from general
  acceptance-criteria sentences with no scenario yet, or from a scenario
  ready to write; all three stages funnel into the same loop (`nuka check`
  through `nuka accept`) that was already there. The prose-to-requirements
  stage reads a requirement against the five EARS patterns as a checklist
  for what has to be stated, not a template to generate wording from: a
  slot the source doesn't support becomes a question addressed to a
  person, never a filled-in guess. Lookup detail that used to keep the
  body pinned at its 500-line limit moved into
  `skills/acceptance/references/`, shipped in the same npm tarball as the
  skill itself; the body went from 499 lines to 372.

## 0.4.0 — 2026-08-16

### Breaking

- **Every id-bearing field on a step record and a scenario record now
  follows one rule: `<grain>_record_id`, or `run_id` for a run.** Before
  this, the same key name meant two different things depending on which
  record it sat on: `scenario` was an id on a step record (the owning
  scenario record's id) but a name on a scenario record (the pickle's own
  name), and a step record's own id was `record_id` on the step record
  itself but `record` inside a scenario record's `steps[]` array. A step
  record's `record_id` is `step_record_id` now; the owning scenario
  record's id on a step record, formerly `scenario`, is
  `scenario_record_id`; a scenario record's own `scenario_id` is
  `scenario_record_id`; a scenario record's `steps[].record` is
  `steps[].step_record_id`. A scenario record's own `scenario` field (the
  pickle's name, never an id) and `run_id` are unchanged, and so are the
  `step-`/`scn-`/`run-` id prefixes themselves. An existing acceptance
  record needs re-creating, the same way 0.3.0's own step record rename
  did: `nuka run` the feature again and `nuka accept` it. `nuka tend`
  reports `signoff-record-old-format` for a record it still finds under
  the old field names, which now includes every record accepted before
  this release, 0.3.0's own step records included, since `record_id` is
  exactly the field `signoff-record-old-format` already checked for.
  The same rule closes two more spots that had kept the old, bare
  convention: a step record's `used[]` entries carried the upstream id
  under `record`; that field is `used[].step_record_id` now, matching the
  name (and the value) the step record it points at already carries on
  itself. The Allure emitter's own step parameter list carried the same id
  under the bare label "record"; every other label there already says what
  it is measuring (`mutates (declared)`, `http reads (observed)`), so this
  one is "step record id" now, not a bare "record".

### Added

- **A step record now also carries `run_id: string | null`**: the owning
  `nuka run` invocation's own id for a `run`-originated step, `null` for a
  `do`-originated one, the same split `scenario_record_id` already makes.
  Reading one step record on its own used to mean opening the scenario
  record beside it just to find out which run it belonged to; the step
  record answers that itself now, the same way it already answers
  everything else about what that one execution did.

## 0.3.0 — 2026-08-16

### Breaking

- **The step-level record is called a step record now, not a receipt.**
  Step-level and scenario-level records answered the same question under
  two unrelated words: `Receipt` here, `record` for the scenario level.
  This folds them into one vocabulary, distinguished by grain (`step
  record` / `scenario record`) only where the distinction matters. What
  the old name carried was never the name itself: it was the fact that a
  step record's `result` had passed the step's own `returns` schema, and
  that fact does not move when the name does, so nothing is lost by the
  rename.
- **`.nukadoko/` now splits into `records/`, `export/`, and `cache/`, by
  purpose.** `records/` is the tool's own measurement of a run
  (`records/steps/<id>/`, `records/scenarios/<id>/`), never committed.
  `export/` (`export/allure-results/`, `export/messages.ndjson`) is
  derived output for a reader outside nukadoko, safe to delete since the
  next run rebuilds it. `cache/` (`cache/sessions/`) is not a record of
  anything that happened, only work avoided, so deleting it costs a
  login, never correctness. See
  [Artifacts](docs/spec.md#artifacts).
- **A step record's own field names and id prefix changed.** `receipt_id`
  is now `record_id`, the `rcpt-` id prefix is now `step-`, and a `used`
  entry's `receipt` key is now `record`.
- **An existing acceptance record needs re-creating.** It embeds each
  step's own record verbatim, so the field-name and prefix change above
  lands inside it too. `nuka run` the feature again and `nuka accept` it;
  `nuka tend` reports `signoff-record-old-format` for one it still finds
  in the old shape.
- **`nuka tend` no longer reports a stale sign-off, or a sign-off's
  drifted condition, once the feature it names lives inside
  `featuresDir`.** Both findings (`signoff-rot`'s four checks and
  `signoff-condition-mismatch`) used to fire for any accepted feature
  regardless of where it lived; now they skip a feature already running
  unattended, because the run itself carries the guarantee those two
  findings used to stand in for, and reporting them anyway would turn
  every ordinary edit to a feature already running unattended into an
  alarm nobody keeps reading. `signoff-record-unreadable` is unaffected:
  a record `tend` cannot even parse has no placement to judge it by. A
  project relying on `nuka tend`'s exit code to catch this for a feature
  already inside `featuresDir` loses that coverage; running that same
  feature, already scheduled on every commit, is what confirms the same
  thing now.

### Added

- **`nuka run` now also writes one Allure test result per *scenario*, on
  top of the existing one per step.** Named `Scenario: <scenario name>`,
  sitting beside its own steps' leaves in the same tree group. Unlike a
  step's own test, a scenario's own test carries an identity that stays
  stable from one run to the next (its own feature path and gherkin name,
  folded together with every step's own text so two scenarios sharing a
  name never collide), so Allure's own history, trend, and
  flaky-across-runs views work again, at scenario grain, once
  `historyPath` (below) is set. This also closes the one display
  regression 0.2.0 recorded in its own entry below: a scenario a Before
  hook stops now shows `failed` on its own scenario-level leaf, not only
  `skipped` on every step underneath it. See
  [Allure emitter](docs/spec.md#allure-emitter).
- **`nuka init` now writes `historyPath` into the `allurerc.mjs` it
  generates**, pointing Allure's own `generate`/`watch`/`report` at
  `.nukadoko/export/allure-history.jsonl`. Without it, Allure never builds
  history at all, no matter how stable a scenario's own identity is;
  `examples/allure/allurerc.mjs` now carries the same field, for a
  project not using `nuka init`.

### Changed

- **`nuka accept` now writes guidance to stderr after a successful
  sign-off**, naming the choice a project has after freezing a record:
  leave the feature where it is, an acceptance claim about one commit, or
  move it into `featuresDir` so it runs unattended from then on. stdout
  is unchanged, still just the record's own path. The acceptance skill
  and `docs/spec.md`'s own "Sign-off" and "Tending" sections now describe
  this as a decision made once, right after sign-off, rather than the
  previous framing, which read strongly enough to be taken as a rule
  against ever running an accepted feature at all.

### Fixed

- **`nuka accept` no longer refuses a second feature just because the
  first accept, from the same green run, left its own record untracked.**
  The dirty-tree refusal protects the tree a run actually read (a step
  file, a feature, the config); an acceptance record is what accepting
  produces, never an input to the run being frozen, so its being
  untracked or changed no longer counts against that refusal, for any
  feature. A path this cannot even read (most likely one deleted since it
  was measured) still counts as dirty, and anything else dirty still
  refuses exactly as before. See [Sign-off](docs/spec.md#sign-off).

## 0.2.0 — 2026-08-15

### Breaking

- **`nuka steps --json`'s top level changed from a bare array to `{ steps,
  import_failures }`.** Anything reading the old bare array needs to read
  `.steps` now; `import_failures` (`{ file, message }`) is new alongside
  it, always present, `[]` when nothing failed.
- **Allure now writes one test per step, not one test per scenario.** A
  run used to put nothing on screen until a scenario was over, so a
  20-step scenario that takes minutes showed a blank report the whole
  time; Allure only updates when a new result file appears and never
  re-reads one it has already seen, and it has no way to show a test that
  is still running, so the only unit it can update at is one finished
  test. Mapping a step to a test was the only way to get feedback at step
  granularity instead of scenario granularity (measured: first result
  lands within 150-351ms of that step finishing). The scenario moves into
  the `suite` label and the feature stays `parentSuite`, so a suite row
  still carries the whole scenario's tally and turns red as soon as one
  of its steps does. This costs Allure history: four ways of identifying
  a step across runs were measured, and every one mis-links two
  different steps as the same one (text collides with itself, position
  shifts on any earlier edit, occurrence counting cannot tell an
  inserted duplicate from the original), so nothing links a step's
  `historyId` across runs any more, on purpose, via three hidden
  parameters that change every run. A migrated suite that kept a
  cucumber-shaped report tied to its old history would have gained
  nothing by moving; the compat door is for getting a suite in, not for
  where it settles, and time-over-time observation stays available
  through `nuka tend` instead (see
  [Allure emitter](docs/spec.md#allure-emitter)). One display
  regression: a scenario stopped by its own Before hook now shows every
  step `skipped` rather than one test turning red, because there is no
  longer a scenario-level test for that failure to live on; `nuka run`'s
  exit code and `record.json` are unaffected, and `nuka accept` is
  unchanged, since the acceptance unit was always the scenario, never
  the Allure report.
- **`nuka steps` now fails when the project has no features directory.**
  It used to print an empty vocabulary and exit `0` there, which reads
  exactly like a project whose features directory exists and simply holds
  no steps yet. Those are different facts, and `nuka check` already told
  them apart: `nuka steps` was reusing discovery's own leniency, where a
  missing directory means "nothing found here" so that an empty
  vocabulary stays a valid answer. The cost landed on the reader who
  reaches for `nuka steps` first, an agent taking its opening move, who
  got a plausible empty answer instead of being told it was in the wrong
  place. Now the resolved path it looked for is named on stderr, stdout
  stays empty in both plain and `--json` form rather than carrying an
  error-shaped payload, and the exit code is non-zero. A features
  directory that exists and holds no steps is unchanged: `{ "steps": [],
  "import_failures": [] }` and exit `0`.

### Added

- **`nuka steps` and `nuka describe` now read the vocabulary per file,
  tolerant of a broken glue file.** One step file that failed to import
  used to take the whole call down with it, which meant the one moment a
  suite mid-migration most needed to read its own vocabulary was exactly
  when these two commands went blind. Now the rest of what discovery could
  read still comes through: the broken file is named on stderr and in
  `import_failures`, and the command still exits 1, since output is not
  withheld but "this succeeded" is not claimed either. `nuka run`, `nuka
  do`, and `nuka init` are unchanged: they are about to execute, or set up
  a project that is about to, so they stay fail-fast on purpose.
- **A typed step's `run()` that this same static reading cannot parse no
  longer empties the whole listing.** `needs` is `null`, with a
  `needs_error` string beside it, instead of throwing the step, and every
  other step, out of `nuka steps` entirely; human output marks the entry
  `needs unreadable` and prints why.
- **That same unreadable `run()` also gets `needs_inferred` for one shape:
  a bare, un-destructured first argument (`run(ctx, args)`, the shape 0.1.0
  replaced with a fixture bag).** A lexical guess at the step's fixture
  needs, read from that argument's own member accesses and filtered to
  known fixture names; a field of its own, never merged into `needs`, and
  never producing `needs_browser`. It misses an alias (`const c = ctx`), so
  it is a starting inventory, not a finished one, and it is simply omitted
  for the other unreadable shapes (a default value, a rest property),
  which carry no identifier to scan by in the first place.
- **`nuka check`'s human output groups a `step-file-import-failed` message
  shared by more than one file.** The message prints once, followed by the
  sorted file list, instead of once per file; a single broken file still
  renders exactly as before, and `--json` is unchanged.
- **`nuka tend` adds one `import-failures-unseen` note when a step file
  could not be imported.** Its own counts and findings were already
  shrinking around a broken file with nothing here saying so; this names
  how many files went unseen and points at `nuka check` for detail.
- **`nuka run` no longer runs silent.** stderr now carries a boundary line
  before each scenario, one line per step as it finishes, every path the
  run actually wrote once it ends, and a one-line summary; a new `--quiet`
  flag drops the two progress lines only, since naming where output landed
  is never worth suppressing for a flag whose whole point is a quieter
  terminal, not a silent one. stdout is unchanged: still NDJSON only, one
  scenario record per line.
- **`nuka tend` adds a `post-navigation-read` note.** For a step whose
  frozen sign-off record shows a call landing shortly after `goto`,
  `reload`, `goBack`, or `goForward` finished, it reports the gap: not a
  verdict that the gap was too short, since only the application's own
  render time decides that and this tool has no way to know it, only the
  fact of how much time passed. A read inside a `ctx.poll` window is
  excluded, since a step written that way is already retrying. Never
  changes the exit code.
- **`docs/upgrading.md` (paired with `docs/upgrading.ja.md`) covers moving
  a project already on nukadoko to a newer release.** `docs/migration.md`
  is for a cucumber-js suite coming in; upgrading is the separate question
  of what an existing nukadoko project has to do about a breaking change,
  split into what stays the same every release and what changed in this
  one.
- **`nuka init` now writes `allurerc.mjs`.** Allure 3's `allure generate`/
  `allure report` read failure categories only from its own config, never
  from a results directory's `categories.json`, so without this file every
  nukadoko failure collapsed into Allure 3's one built-in "Product errors"
  category instead of one of the seven `error.kind` ones. The file's seven
  rules are built from `NAME_BY_KIND` (`src/report/allure/categories.ts`),
  the same source `examples/allure/allurerc.mjs` has always been checked
  against, so the two can never drift apart. `init` checks all six
  extensions Allure auto-detects (`allurerc.{js,mjs,cjs,json,yaml,yml}`)
  first and writes nothing, naming the file it found on stderr, when a
  project already has one.
- **The Allure report is now confirmed against a real browser, not just
  against `allure-js-commons`' own API.** A selftest scenario runs `nuka
  run` against a small fixture with a passing, a failing, and a
  Before-hook-stopped scenario, generates the report with the real
  `allure` CLI, serves it over a real HTTP server, and drives a real
  headless browser against it, reading only data-dependent content (a
  count, a tree row, a status), never the report shell's own boilerplate.
  Confirmed this way: pass/failed/skipped counts match what `nuka run`
  itself reported, a scenario renders as its own group and a step as one of
  that group's rows, a failed step's `receipt.json` attachment is present
  and its own content is readable, `allurerc.mjs`'s categorization actually
  sorts a failure away from "Product errors", and a step's `sections`/
  `polls` render as its own child steps, one level under it, not two.
- **`allure watch` updating live, not just a finished report, is now a
  repeatable check, not a one-off scratch script.** README and
  docs/spec.md already said a run's report can be watched from before the
  first `nuka run` and re-renders as each step finishes; nothing had
  confirmed that claim more than once. A selftest scenario now starts
  `allure watch` against an empty results directory, opens the report in a
  real headless browser exactly once, and spawns `nuka run` against a
  fixture with deliberately slow steps without waiting for it to finish, so
  the browser tab is read while the run is still going. The mid-run count
  it observes has to sit strictly between 0 and the run's own final total,
  or the scenario fails: that in-between reading, arriving with no
  `.goto()`/`.reload()` from the test itself, is the only evidence a
  report update actually arrived on its own.
- **A browser-driven run's own evidence now reaches a real report too.**
  Stage 2 above read a finished report and stage 3 watched one update live,
  but neither ever launched a browser inside the run under test, so the
  Playwright-native redesign's own artifacts (a trace per step and per
  hook, that trace's own calls as child steps, `page_events` counts, a hook
  that touches the browser as its own fixture) had never been opened on
  screen. A new selftest scenario runs a fixture feature whose Before hook
  and step both navigate a `data:` URL (`page.setContent()` never produces
  a `goto` action; a real navigation does) and confirms all four: the
  step's own trace attachment downloads as a valid, non-empty zip; the
  Before hook renders as its own fixture; the trace's own `goto` action
  shows up as a child step, the same locator stage 2 already uses for
  `section:`/`poll:`; and each `page_events` category's parameter reads the
  same count the step's own receipt recorded. Kept in a feature of its own
  so stage 1 through stage 3 keep their existing runtime.
- **`nuka run` now takes a directory in place of a single feature file.**
  `nuka run features/` walks it recursively for every `.feature` file and
  folds all of their pickles into the one invocation: one run_id, one
  summary, one exit code, one messages stream, one Allure results tree, in
  a fixed order (the repo-relative path compared byte by byte, not by
  locale) so a record or a report stays comparable across runs. `:line` on
  a directory is refused, and a directory with no `.feature` file anywhere
  under it fails setup, naming what it walked, the same tone `nuka check`'s
  own `no-step-files-found` uses. README's own CI example
  (`npx nuka run features/`) now runs as written.
- **An unknown parameter type now names the ones this project has.**
  `{count:number}` is a natural thing to write and cucumber-expressions
  answers it with "Undefined parameter type 'number'", which says what is
  wrong without saying what would be right. The message now carries the
  names actually registered for this project, read from the live registry
  rather than a fixed list, so the ones a project added through
  `config.parameterTypes` or a compat `defineParameterType` appear beside
  the built-in ones. A list written into a document could not have done
  that, and would have been wrong for exactly the projects that extended
  the vocabulary furthest.
- **`nuka scaffold`'s template now explains `rationale`.** The template
  guided every other field and said nothing about this one, while
  `nuka tend` flags a step that lacks it (`step-rationale-missing`), so a
  step written the way scaffold suggested was reported the moment anyone
  tended it. The comment says what belongs there (why this shape, what was
  rejected) and how it differs from `description`, which says what the
  step does.
- **`nuka accept`'s dirty-tree refusal now names the state directory when
  that is what is dirty.** A project that never gitignored it (`nuka init`
  does this automatically, but an existing project migrated by hand can
  miss it) could get stuck in a loop: dirty, commit, accept refuses because
  HEAD moved, run again, dirty again from the same state directory, forever.
  The refusal now says whether the dirty paths are entirely or partly under
  the state directory and that `nuka init` gitignores it for that reason,
  without assuming the project didn't mean to track it; a tree dirty for an
  unrelated reason gets the same message as before.
- **`nuka mcp-tools -- <command> [args...]` and `connectMcpServer`/
  `callMcpTool` (from `"nukadoko/mcp"`) reach an ordinary MCP server over
  stdio.** The first reads whatever tools a server declares and prints
  them; the second lets a hand-written step call one and throws when a
  tool reports an in-band failure (`isError: true`), which MCP itself
  returns as a normal, successful response rather than a rejected promise.
  Both are kept apart from `nuka steps` on purpose: a server's own
  declared tools are material for a person writing a step's `args` by
  hand, never something this package turns into a step or its vocabulary
  on its own. A server's process lifetime rides on the existing fixture
  mechanism instead of a new config key: a fixture calls `connectMcpServer`
  in its own setup and `client.close()` in its own teardown, the same
  setup/teardown/scope shape any other fixture-owned resource already
  uses. `@modelcontextprotocol/client` is an optional peer dependency, so
  a project that never touches this surface never installs it; `nuka
  mcp-tools`'s own CLI wiring reaches it through a dynamic import for
  exactly that reason, and names the exact version to install when it is
  missing. `connectMcpServer` connects with the client package's own
  2025-era default (no probe, no new headers) unless a caller passes its
  own `ClientOptions` as a second argument, forwarded straight to
  `Client`'s own constructor, most usefully to opt into the 2026-07-28
  handshake through `versionNegotiation`.
- **`nuka experimental webmcp-tools <url>` and `experimental_callWebmcpTool`
  reach a page's own declared tools, via `navigator.modelContext.registerTool`.**
  Both carry their mark in a position a caller cannot route around, because
  the WebMCP standard's own documentation says it is subject to change, and
  its English and Japanese pages currently disagree about whether a caller
  shaped like this one is supported at all; it measurably works against
  Chromium 149 today, and that is measured, not promised, with the
  condition for dropping the prefix written beside it. The listing is a
  separate face from `nuka steps`, deliberately: folding a page's declared
  tools into the step vocabulary would let the page under test decide part
  of the vocabulary that checks it. Calling a tool needs nothing from the
  executor but `page`, which a step already receives, so it is a plain
  import rather than a fixture. The launch flag Chromium needs is never
  injected: a project states it in its own config's `browser.args`, the
  same as any other Playwright launch option, and a page missing the API
  raises its own error rather than reporting zero tools, so "nothing
  declared" and "no API to ask" stay distinguishable.

## 0.1.0 — 2026-08-06

### Breaking

- **A typed step's `run` now takes a fixture bag, not `ctx`.** Collect what a
  step read off `ctx` into a destructured first argument (`run({ page,
  section }, args)`), and drop the `await` and call parentheses on `page`/
  `request`: they are values now, not functions. No codemod ships for this.
  See "A typed step's `run` takes a fixture bag now, not `ctx`" under Changed
  below.
- **`evidence.trace` moved off the scenario record onto each step's own
  receipt.** Anything reading the scenario record's `evidence.trace` needs
  to read the receipt of the step that opened a page instead; there is no
  longer a single trace spanning the whole scenario. See "`evidence.trace`
  is a step's own trace now, not the whole scenario's" under Changed below.
- **A sign-off record's filename now carries its condition.** The old
  `<feature-basename>.<date>-<sha>.md` is
  `<feature-basename>.<date>-<sha>.<environment>.<browser>.md` now; anything
  reading the old filename shape needs to read the new one. See "A sign-off
  is now scoped to a condition, not just a feature and a commit" under
  Changed below.

### Added

- **The Allure report carries what nukadoko measured.** Three things
  nukadoko had been recording never reached the report at all. Each step's
  own receipt is now attached whole as `receipt.json`, so a field the
  receipt gains later arrives without a second mapping to keep in sync.
  `sections`, `polls`, and now `actions` merge by their absolute timestamps
  into a child-step timeline under the step they belong to, which is what
  those `at` fields were added for: a poll renders with its real duration
  and its own outcome, and its name carries the attempt count, because one
  attempt and forty attempts ask for opposite fixes and nothing else in the
  report tells them apart. An action renders with its own real duration
  too, named after its method and target (`goto /orders`), an `expect`
  call named by its matcher and target instead (`expect #late
  to.be.visible`); never by its own duration, already visible as the child
  step's width. A truncated `actions` array gets one more child step at the
  timeline's tail naming what got cut, so the timeline alone never reads as
  the whole story when it is not. `page_events` counts appear as
  parameters, so a step that passed while the page logged three console
  errors says so without anyone opening an attachment, and a truncated
  category reads `100 of 4213` rather than the number it happened to keep.

- **A receipt now records what the page itself said.** Console errors,
  uncaught page errors, and failed requests land on the step's own receipt
  under `page_events`, so a step that passed while the page threw three
  uncaught errors is readable instead of invisible. The subscription sits on
  the BrowserContext rather than the Page, which is what lets it pick up a
  popup (`window.open`) without a second listener. Each category caps at 100
  entries; when one is cut, a sibling `truncated` field carries the true
  total, because a field whose shape changed with volume would make `jq
  '.page_events.console_errors | length'` quietly answer a different
  question. Secrets are redacted on the pass the rest of the receipt already
  goes through. Service workers stay outside this: a `Worker` has no request
  or error event to subscribe to, so what they emit is not covered.

- **A step's receipt now records what it did on the page, timed.** Every
  Playwright call a step made through `ctx.page()` lands on `actions`,
  `expect` waits included, each with its own duration (`ms`), outcome, and
  absolute timestamp. No `expect` fixture exists to make this work: a step
  reaches `expect` the same way a Playwright test file would, and the trace
  records the call underneath that wrapper. Only five parameter keys
  (`selector`, `expression`, `url`, `isNot`, `timeout`) ever reach the
  receipt; a `setContent` call's own HTML body, for one, stays in trace.zip
  where it belongs. Capped at 100 entries with the same `truncated` sibling
  `page_events` already uses. Redacted on the same pass as the rest of the
  receipt. A trace format version this build does not recognize costs
  `actions` and gets one stderr warning, never a guess.

- **http.jsonl now records the page's own traffic too, not just
  `ctx.request()`.** A step's `ctx.page()` calls used to leave no trace in
  http.jsonl at all: `observed` counted them, but the URL they hit was
  nowhere on the receipt. Every response for a `document`, `xhr`, or
  `fetch` request now lands there beside `ctx.request()`'s own entries,
  each line marked `via: "request"` or `via: "page"`, so neither reads as a
  guess. Images, stylesheets, and scripts are left out on purpose, since a
  single page load can pull in dozens, but never silently: what didn't
  make it in is counted by resource type on the receipt's new
  `http_omitted` field. `observed` is untouched by any of this; it still
  tallies every request the page made, image and script traffic included,
  because it answers a different question than http.jsonl does, and the
  two numbers were never meant to match.

- **`nuka steps --json` now reports each typed step's own fixture needs.**
  Two new fields per step: `needs` (the names its `run()` destructures,
  alphabetized) and `needs_browser` (whether `page` or `context` is one of
  them). Both were already readable, `check` parses the same destructuring
  to catch an unknown fixture name before anything runs; this just exposes
  that same static reading outside `check`, so an agent can tell, before
  running anything, which scenarios never open a browser at all. `needs` is
  never omitted for a typed step, even when it is `[]`, so "this step needs
  nothing" reads differently from a compat entry, which has neither field
  at all (no `run()` exists to read). The non-JSON listing stays terse: it
  marks a browser-needing step with a single word rather than repeating the
  full `needs` list, which stays a `--json` concern.

- **Steps can now order a project's own resources by name, not just
  Playwright's.** `nukadoko.config.ts` gains `fixtures`: a name mapped to a
  bare function, or a `[function, options]` tuple, the same two shapes
  Playwright's own fixture definitions take. This is the place a step's own
  tenant, seeded database, or uploaded file finally has somewhere to put its
  cleanup, without writing that cleanup into the step itself (which would
  make the feature file name something that is not an acceptance
  condition). `defineFixtures`, exported from the `nukadoko` package, keeps
  a fixture map fully typed under `strict`: a plain `export const fixtures =
  {...}` loses TypeScript's own contextual typing the moment it leaves an
  inline call and fails to compile with implicit `any`. A fixture may depend
  on a builtin, on another fixture, or override a builtin outright (`page:
  async ({ page }, use) => {...}` reads `page` as the builtin underneath it,
  never as itself); `auto: true`, Playwright's own "build this even if
  nothing asked for it" option, is refused outright, with a message naming
  why. Two scopes exist: `scenario` (default, rebuilt per scenario or per
  `nuka do` execution) and `process` (built once for the whole `nuka run`
  invocation, the first time any step names it, reused after that); there is
  no `worker` scope, since nukadoko has no parallel execution yet for that
  name to mean anything different from `process`. `process` names one
  address space, not one `nuka run` invocation: the two happen to coincide
  today, but that is not a guarantee, and something that must happen exactly
  once in the world (seeding a database, running a migration, starting a
  mock server that owns a port) does not belong in a `process`-scope
  fixture. Teardown runs in reverse build order regardless of whether the
  step passed or failed, and `use()`'s own return value (`"passed"` or
  `"failed"`) is how a fixture learns which, so it can decide for itself
  whether to keep or discard what it built (a QA team's standard "keep the
  failed one to inspect, destroy the passed one" now has somewhere to
  live). A teardown failure never changes a step's or scenario's own
  status; it lands on the scenario record's new `teardown_errors` (a
  `scenario`-scope fixture) or on stderr (a `process`-scope fixture, torn
  down once with no single scenario record to carry it), and `nuka
  run`/`nuka do` announce it either way without touching the exit code.
  Setup and teardown each get their own timeout (`config.fixtureTimeout`,
  default 60 seconds, overridable per fixture), and a fixture that forgets
  to call `use()`, or calls it twice, is detected and thrown by name rather
  than left to hang the run forever. `nuka check` gains three findings, all
  decided without running a fixture: `fixture-cycle`, `fixture-scope-
  violation` (a `process`-scope fixture depending on a `scenario`-scope
  one), and `page-override-unowned` (a `page` override that owns neither `page`
  nor `context`). `nuka tend` gains two more, both a fact rather than a
  verdict: `fixture-unused` and `fixture-touches-app` (a fixture that
  reaches `page`/`context`, the standing answer to a fixture quietly logging
  a user in before any step asks for it). A receipt now carries `fixtures`,
  one entry per `config.fixtures` entry that step's own bag actually
  touched, `reused: true` telling "already built" apart from "built in
  0ms". `nuka steps --json`'s `needs_browser` now closes over this same
  graph: a step that only destructures a fixture which itself reaches
  `page` reads `needs_browser: true` too.

- **`ctx.page()` can launch firefox or webkit now, not only chromium.**
  `nukadoko.config.ts` gains `browserType` (`"chromium"` by default,
  `"firefox"`, or `"webkit"`), a separate key from `browser` rather than a
  field inside it: `LaunchOptions` (`browser`'s own type) has no key that
  selects an engine at all, so mixing one in would accept something that
  type has no room for. A project that never sets `browserType` launches
  exactly what it always has. Firefox and webkit each still need their own
  binary installed (`npx playwright install firefox`/`webkit`); a missing
  one surfaces as Playwright's own error at launch time, unmodified. Every
  scenario record now also carries `browser: { type, version }`, read from
  the real `Browser` object a run actually launched, never from
  `config.browserType` itself, since a step can override the `page` fixture
  with a different browser than config declared. Absent for a scenario
  whose run never launched a browser at all, the same convention
  `evidence.trace` already follows.

- **A step can now add its own evidence, not only what the harness collects
  on its own.** Two personas asked for this independently: an API response
  body, a DB state snapshot, a generated file's contents, none of which had
  anywhere to go before, short of logging to `console.log` and losing it, or
  a step writing to disk on its own with no place on the receipt to point
  at. `evidence.attach(name, body)` writes `body` (`string | Uint8Array`)
  into the step's own evidence directory and lists it on the receipt's new
  `evidence.attachments`, `{ name, file, at }`; calling it twice with the
  same `name` keeps both files, never overwriting the first. `evidence.path
  (name)` is Playwright's own `testInfo.outputPath()`: it allocates a
  collision-free absolute path without writing anything, and only a path a
  step actually wrote to by the time execution ends lands on the receipt, so
  book-keeping a call was made is never mistaken for evidence that a file
  exists. A `name` containing a path separator, or equal to `.`/`..`/the
  empty string, is refused outright rather than silently rewritten. Capped
  at 100 entries per execution, sorted by `at`; the true total, once that
  cap is hit, reports through the same sibling `truncated` field
  `truncated.actions` already uses, now `truncated.evidence` alongside it.
  The Allure emitter attaches each one the same way it already attaches
  trace/screenshots/http, contentType guessed from the file's own
  extension, `application/octet-stream` when it cannot be.

- **Step discovery reads `.js` and `.mjs` step files, not just `.ts` and
  `.mts`.** A suite whose glue is plain JavaScript, cucumber-js's own
  official ESM sample among them, used to be entirely invisible to
  discovery: an empty vocabulary and every scenario reporting `undefined
  step`, with nothing saying why the vocabulary came back empty. `nuka
  check` now also says why in two new findings:
  `step-file-unsupported-extension`, naming a `.cjs` file discovery walks
  but never imports (`.cjs` is CommonJS regardless of `package.json`'s own
  `"type"`, and nukadoko is ESM-only, an already-documented go/no-go), and
  `no-step-files-found`, naming the directory a walk that found nothing
  loadable actually scanned.

### Changed

- **`evidence.trace` is a step's own trace now, not the whole scenario's.**
  A Playwright trace used to be one file spanning a scenario's whole shared
  browser context, living in the scenario's own directory rather than on any
  one step. It is cut at every step boundary instead: a step that never
  calls `ctx.page()` gets no trace of its own, and a step that does gets one
  holding only what it did, in that step's own receipt directory. Opening
  the trace for the step that actually failed is faster than scrubbing a
  whole scenario's recording for the moment things went wrong, which is the
  whole reason for the change. The scenario record's own `evidence.trace`
  is gone with it: what a single scenario-long trace also gave for free, a
  network view spanning every step at once, a step-scoped trace does not.
  Each step's own trace still shows that step's own requests in full;
  `ctx.request()` traffic keeps its own record in http.jsonl, and (see
  below) page-issued traffic now shares that same file. A Before/After/
  AfterStep hook that touched the browser used to fall through this cut
  entirely: its own `ctx.page()` calls landed in no chunk at all, since a
  chunk only ever opened for a step's own boundary. Every individual hook
  invocation now gets the same treatment a step does, its own isolated
  trace and `actions`, recorded on that invocation's own entry in the
  scenario record's `hooks` array (`trace`, relative to the scenario's own
  directory, since a hook has no receipt dir of its own) rather than
  disappearing the way it used to. The Allure emitter attaches a hook's
  trace to that hook's own fixture and merges its `actions` into that same
  fixture's child-step timeline, matching what a step already gets.

- **A typed step's `run` takes a fixture bag now, not `ctx`.** `run(ctx, args)`
  becomes `run({ page, section }, args)`: only the names a step actually
  destructures ever get built, so a step naming neither `page` nor `context`
  never launches a browser, a fact `check` can now read from the source
  text itself, before anything runs. To migrate a step, collect every
  `ctx.foo` it reads into that first destructured argument, then drop the
  `await` in front of `ctx.page()`/`ctx.request()` along with the call
  parentheses; `page` and `request` are values now, not functions. A
  destructured fixture with a default value or a rest property (`{ page =
  null }`, `{ ...rest }`) is refused, with its own message, since neither
  can be read statically; name every fixture a step needs explicitly
  instead. No codemod ships for this: the reader here is an agent, and a
  mechanical rewrite across a whole `features/steps/` tree is exactly the
  kind of batch edit an agent already does well.

- **A sign-off is now scoped to a condition, not just a feature and a
  commit.** "Chromium accepted, firefox not yet" is a normal state: the
  condition, `(environment, browser)`, is read off what a run actually
  measured, never a declaration, so `nuka accept` now selects among runs
  whose own measured `browser.type` matches the current `config.
  browserType`, and a run that never launched a browser at all stays a
  candidate no matter what `browserType` currently says, since an
  unmeasured axis was never part of what that run confirmed. This is the
  breaking part: the record's own filename now carries the condition too,
  `<feature-basename>.<date>-<sha>.<environment>.<browser>.md` in place of
  the old `<feature-basename>.<date>-<sha>.md` (`<browser>` reads
  `no-browser` for a run that launched none; never a version, which stays
  in the record body only), so two conditions never collide and silently
  overwrite one another. A record's own body gains a "Condition" section
  stating both, explicitly, even when no browser was launched. When no
  run matches the current condition, the refusal now says so and lists
  which conditions do have a green full run, instead of reading as "no run
  exists" when one does, just under a different condition. `nuka tend`
  gains one more note, `signoff-condition-mismatch`: the most recent
  sign-off for a feature naming a browser the current config no longer
  declares, never an error, since nothing about it is wrong yet. A record
  accepted before this shipped carries no condition at all; `nuka tend`
  reads it fine and leaves it out of this one note rather than guessing.

### Fixed

- **Step discovery no longer walks `node_modules` or imports a `.d.ts`
  file.** A project with `featuresDir` set to something wide (a repository
  root, for instance, a real configuration observed in the wild) had
  discovery recurse into every dependency's own files under
  `node_modules`, type declarations included, trying to import each one as
  though it were a step definition. `node_modules` and any dot-directory
  (`.git`, `.nukadoko`, an editor's own `.vscode`, ...) are now skipped at
  every depth, and `.d.ts`/`.d.mts` files are excluded outright.

## 0.0.5 — 2026-08-05

### Changed

- **`nuka do --args` is optional once `--use` is given.** A step whose every
  argument arrives via `from` used to still demand `--args '{}'` on the
  command line: ritual, not a real requirement, once `--use` already says
  "arguments come from the chain". `--args` stays required the rest of the
  time: the exemption only fires when `--use` is present, so a bare `nuka do
  <step>` (neither flag, likely a typo) still fails fast with a message
  naming both flags instead of parsing and only failing later at args
  validation.
- **`nuka tend`'s summary is three lines, not two.** A `scanned:` line comes
  first, naming every directory that run actually looked at (a finding that
  turns out to be wrong is unreadable without knowing what produced it), and
  the `bed:` line now also counts read-only typed steps. Both lines are
  summary, not findings: neither affects the exit code. Called out here
  rather than filed under Added because anything counting `nuka tend`'s text
  output breaks on it; `--json` carries the same fields and does not shift
  under you.
- **`poll` moved onto `ctx`, and now leaves a record.** `import { poll }
  from "nukadoko"` is gone; the same loop is `ctx.poll(fn, options)`, and
  every completed call lands on the receipt's `polls` with how many
  attempts it took, how long it waited, and whether it resolved, timed out,
  or threw. It was an import because it needed nothing the executor owned,
  which was true and was the wrong thing to optimize for: a wait that
  leaves no trace cannot be told apart, afterwards, from one that returned
  on its first attempt. Those two situations call for opposite fixes.
  One attempt at 0ms says the condition was already true and the wait was a
  no-op, so whatever is late is something else entirely; forty attempts
  over 20s says that condition really was the late one. From outside the
  step the two look the same, which is exactly when a receipt is supposed
  to be the thing that answers. Recording it means writing into a collector
  the executor owns and resets at each step boundary, and that is what puts
  it on `ctx`: the same route `ctx.section` took, for the same reason,
  after the same mistake. A timed-out poll is recorded like any other: the
  receipt of the step that failed on that timeout is precisely where the
  numbers are wanted. Migration is mechanical: drop the import, call
  `ctx.poll` instead.
- **A browser step's evidence is one screenshot, not two.** The former
  `finalize(status)` took a screenshot once and wrote the same buffer to
  both `final.png` and, on a failed run, a second time under a second name.
  That second file carried zero additional information, since
  `receipt.status` already answers "did this fail". Worse, because that
  screenshot only ever runs after `run` has already returned or thrown, the
  second copy could be taken seconds after the failure it was named for,
  showing a page that had since changed: `status: "failed"` sitting next to
  a screenshot that looked fine, an apparent contradiction with no fix but
  to distrust one of the two. A real run once measured that gap at roughly
  eight seconds, misdiagnosed as the state itself flickering. `finalize`'s
  and `dispose`'s own `status` argument is gone with it: it had no
  remaining use once the second file did.
- **`evidence.screenshots` entries are `{ file, at }`, not bare file
  names.** `at` is the ISO 8601 moment the screenshot actually resolved (the
  same format `started_at`/`finished_at` already use): the fact a second
  screenshot file used to exist to paper over without ever stating it. A
  screenshot's own timestamp is now on the receipt directly, so a reader
  does not have to guess how stale it might be relative to the step's own
  `finished_at`.
- **`sections` entries are `{ label, at }`, and `polls` gained `at`.** A
  label used to say only that execution reached a stage, never when. "When"
  turned out to matter: a receipt can carry a `status: "failed"` next
  to a screenshot that looks unaffected, and without a shared timeline there
  was no way to tell a real state change apart from a read taken before the
  state settled. `sections`' `at` and `polls`' new `at` (alongside
  `waited_ms`) put every stage and every wait on the same absolute timeline
  `started_at`/`finished_at`/`evidence.screenshots[].at` already use, so
  that question has an answer from the receipt alone.
- **User-facing strings across the CLI no longer use an em-dash.** Forty of
  them changed: `nuka check` and `nuka tend`'s finding messages, `nuka
  accept`'s refusal text, and other strings the CLI prints straight to a
  reader trying to find out what went wrong. `nuka accept` alone had eight,
  more than any other command, since every one of its messages is a reason
  someone cannot do the thing they just tried. Anything that greps one of
  these strings for an exact match is affected: 0.x never made the wording
  a contract, but the wording did move, and that is worth recording here.
  The information itself did not shrink: most of the forty became two
  sentences in place of a comma, so a reader gets the same facts, just
  differently punctuated.

### Added

- **`additionalFeatureDirs` config, and a wider static scan.** A step's
  pattern is bound or unbound as a property of the whole project, not just
  of what an unattended `nuka run` would execute today. So an acceptance
  feature, recommended to live outside `featuresDir` precisely so it never
  runs as a regression, made `nuka check`/`nuka tend` report its steps
  `pattern-unbound` even though they genuinely bind. `additionalFeatureDirs`
  (default `[]`) names directories `nuka check` (no argument) and `nuka
  tend` scan in addition to `featuresDir`, without ever executing them.
  `nuka run` still reads `featuresDir` alone. Two findings come with it: a
  configured `additionalFeatureDirs` entry that does not exist
  (`additional-feature-dir-missing`, an error on `check`, a note on `tend`)
  and an accepted feature outside every scanned directory
  (`signed-feature-unscanned`, a `tend` note: deliberately never used to
  widen the scanned set itself, since that would only ever notice a
  feature already accepted at least once, silently missing the one still
  being drafted).
- **A failed step's receipt carries the upstream values it read.** Each
  `used` entry on a failed step's receipt now also carries `result`: the
  full validated result of the receipt it cites, not only the id and step
  name. Diagnosing a failure used to mean opening a second receipt.json for
  every upstream step a `from` or `resultOf` read from; now the one
  receipt that failed already has it. Present only on a failed receipt (an
  `ok` receipt's own `result` already holds whatever value mattered, so
  repeating an upstream one there would be redundant), and carries the
  whole result rather than the one key that was actually read, since a
  diagnosis needs why the value came out that way, not which key was
  cited.
- **`nuka run <feature>:<line>` says that it is a partial run.** Running one
  scenario is the iteration path and is worth taking: a feature's full run
  costs every scenario's minutes. What it is not is a smaller version of the
  same thing: a partial run can never be signed off, so a green one is a
  debugging result. That was already true and was discoverable only at the
  end, when `nuka accept` refused a road that had been chosen several runs
  earlier. It is now said where the line number is given, on stderr, leaving
  stdout's one-record-per-line contract untouched.
- **`nuka accept`'s refusals name what they were decided from.** A run that
  was red, or a feature that only ever had partial runs, now come back with
  the run in question: its id, when it started, and which of its scenarios
  failed, or which lines the most recent partial run covered. The refusal
  reasons themselves are unchanged; what changed is that the next command
  can be chosen against the record instead of guessed at, which is what the
  git-state refusals in the same command already did.
- **`nuka scaffold`'s template stops framing `returns` as "what later steps
  cite".** That framing is the one a first reader adopts, and it drops every
  value the step's own correctness depends on but nothing downstream reads:
  the date it computed, the id it picked, the name it resolved before
  sending. Those are exactly the values a receipt gets interrogated for once
  a run has gone wrong. A step that sends a date nothing cites, computed in
  the wrong timezone, leaves a receipt that cannot say which date it sent.

## 0.0.4 — 2026-08-04

### Added

- **`nuka tend`, for what is rotting rather than what is broken.**
  `nuka check` answers whether a project can run right now, and everything
  it prints stands between the project and a green run — which is what
  makes its output worth reading, and why findings nobody has to act on
  today do not belong there. Printed before every run, they would train
  people to skim past the line that did have to be acted on. `tend`
  answers the other question, read at a different moment: is this
  vocabulary, and the record it produced, still healthy.
  One finding is an error and exits non-zero — a sign-off that no longer
  matches the code it froze: a frozen `result` that no longer passes its
  step's current `returns` schema, a frozen feature source that no longer
  matches the file, a cited step gone from the vocabulary, or a record that
  cannot be read at all. A record that has quietly stopped meaning what it
  says is worse than no record, because it is still being counted.
  Five are notes a project is allowed to carry: a `from` no occurrence
  exercises, a patterned step no feature binds, a schema field with no
  `.describe()`, a step with no `rationale`, a configured parameter type no
  pattern uses. The middle two are aimed at the agent rather than the
  reader — `nuka describe` is how an agent learns what a field means and
  whether it may rewrite a step, and both go quiet when those are missing.
  Findings state facts and never instruct: a `from` no feature exercises
  may still be reached through `nuka do --use`, so the note says what is
  true and leaves the decision where it belongs.
  It opens with where the bed is — how much of the vocabulary is typed
  rather than still compat, and how much of what a step could declare is
  declared. That is not a finding and does not touch the exit code; a suite
  mid-migration is in a normal state. It exists because the information was
  already there and unread: a receipt's `world` and `declared` counts do
  shrink as a suite promotes, which is true and useless as a way for a
  person to see progress. `--json` names the compat steps rather than
  counting them, since what reads it is assembling work.
- **`from` on `defineStep`, and the binding-order check it buys.** Passing a
  value from one step to the next had exactly one shape: declare the args key
  optional, and fall back to `ctx.resultOf` inside `run`. That worked, and
  cost three things — boilerplate per dependency, an `args` schema that
  called a key optional when the step actually required it, and a dependency
  no tool could read, so a scenario binding the consumer before the producer
  was indistinguishable from a correct one until minutes of real browser time
  had been spent on it. `from: { projectId: [createProject, "id"] }` states
  the same fact as data: this args key is the `id` of whatever that step
  returned earlier in this scenario. A pattern capture still wins, the value
  is filled in before args validation — so the key stays *required* and the
  schema goes back to describing what the step demands — and `nuka check`,
  plus `nuka run` before it executes a scenario, verifies the producer
  actually appears earlier in the same pickle, Background included. A
  required key with neither capture nor producer is an error, since that run
  could only fail args validation anyway; an optional one is silent, because
  the schema already said the value may be absent and warning about a
  contract being honored is noise. A key name, never a selector function:
  a name survives into `nuka steps --json` and `nuka describe` as
  "`projectId` ← `createProject.id`", which is what lets an agent assemble
  an order nobody told it, and what `check` reads.
  A key may list several mutually exclusive producers —
  `[[createProject, "id"], [importProject, "projectId"]]` — for a value
  reachable two ways, so the consumer stays one step instead of splitting
  into two. No priority comes with them: no declaration order, no
  most-recent rule reaching across different steps. The check requires that
  exactly one listed producer is bound earlier in the scenario, and two or
  more is an error whether the key is required or optional — a schema gets
  to say a value may be absent, but none asked for "either of these, and
  the feature file cannot tell you which". A scenario that genuinely
  exercises both producers is not describing alternatives at all and gives
  each its own key. `ctx.resultOf` is unchanged and stays for the reads a
  key name cannot express — a value needing reshaping, a read decided at
  run time, a whole result used as one.
- **`nuka do <step> --use <receipt-id>`** (repeatable) supplies a `from` key
  from an earlier execution's result, so a chain assembled by hand across
  several `do` calls no longer means hand-writing JSON from the previous
  receipt. The upstream step's name is not written on the command line
  because the receipt already carries it: nukadoko reads which step that
  receipt records, finds the `from` entries pointing at it, and takes the
  named keys out of its stored `result`. `--args` still wins for the same
  key. A receipt whose step no `from` entry names, or whose execution
  failed, is an error rather than a silent no-op — a failed step never
  produced a validated result to read.
- **A `Step` that discovery never registered is now an error rather than a
  permanent `undefined`.** Both `from` and `ctx.resultOf` identify the
  upstream by the `Step` object's own identity, so a step reached through
  `await import()` resolves to a different instance than the one discovery
  registered and matches nothing. That used to be silent: `resultOf` simply
  returned `undefined` forever, with no failure to trace back to the import.
  `from` names its upstream statically, so `nuka check` reports it and
  `run`/`do` refuse to execute the step at all; `resultOf` can only be
  caught at the call, where it now throws and names the dynamic-import
  mistake. A registered step that has not run yet still returns `undefined`
  — that is a state, not a mistake.
- **`required_env` on every receipt.** `ctx.requireEnv()` is the one call
  site the library controls on the way to a required environment variable,
  so the names passed through it are recorded as a measurement rather than
  derived by reading step sources: deduplicated, in first-read order,
  omitted when empty — the same shape `used` and `sections` already have.
  Names only, never values, since a value can be a secret. Recorded before
  a missing key throws, so a run that failed for one still reports what it
  asked for. A step reading `ctx.env[name]` directly leaves no trace: that
  path is a plain object no code here mediates. Nothing reconciles these
  names against anything yet — there is no contract on the nukadoko side to
  reconcile them with, and the shape of one should be decided against what
  actually gets measured rather than ahead of it.
- **`browserContext` and `requestContext` config keys.** `newContext`'s
  options had no way in at all, which left `ignoreHTTPSErrors` unreachable:
  a project behind a self-signed certificate could use neither `ctx.page()`
  nor `ctx.request()`, with no workaround from inside a step. Two keys
  rather than one, because `browser.newContext()` and
  `playwrightRequest.newContext()` take two different option types — even
  an option both accept is not the same type on each side, so one shared
  key would mean hand-writing a union instead of deferring to Playwright's
  own types. `baseURL` and `storageState` are rejected on both, with a
  reason in the error: `config.baseURL` is meant to be the only place a
  base URL is stated, and the session mechanism owns `storageState`.
- **Acceptance records end with a `## Declared vs observed` section.** The
  material for that comparison was always in the record — every receipt it
  embeds carries both `mutates` and `observed` — and nothing performed it,
  so a wrong declaration stayed falsifiable but never falsified. The
  section lists every step that declared `mutates: false` and was measured
  making a write. It states the raw fact and no verdict, because a step
  that reads over POST lands there on every acceptance by design. It never
  refuses: the seven refusal conditions are unchanged. It is present even
  when nothing disagrees, so "compared, found nothing" stays
  distinguishable from "never compared", and compat steps are counted
  separately rather than folded into the clean case.
- **`nuka init` creates `<stateDir>/allure-results/`.** Allure's CLI
  refuses to start against a results directory that does not exist, so
  `allure watch` failed on any project that had not run yet — which
  inverts what `watch` is for, since its whole point is to already be
  running while a run happens. An empty directory is enough for it.

### Changed

- **Three findings moved from `nuka check` to `nuka tend`.**
  `parameter-type-support-origin`, `secrets-public-key-unknown`, and
  `secrets-redact-key-unknown` all describe a run that will succeed, so by
  the line the two commands are split on — is this something to know
  *before* this run — they were on the wrong side. The first is the clearest
  case: it appears for as long as a suite has any compat glue left, which is
  a normal state to be in, and printing it before every run trains people
  past the lines that do stop one. The codes are unchanged, so the move is
  a change of address rather than of vocabulary.
  Their neighbours stay on `check`, and the contrast is the point:
  `secrets-redact-key-too-short` and `tracked-secret-looking-key` both mean
  plaintext reaches a log the moment the run starts, which is exactly
  something to know beforehand. So does `then-compat-step` — a compat step
  in Then position is a live tension about this run, and promoting it is
  only one of the ways to resolve it.
- **A receipt's `used` names the step beside each receipt it cites.** It was
  a bare list of receipt ids, which made an acceptance record unreadable
  without resolving every id against other files — files that are local
  working records under `.nukadoko/`, while a sign-off is meant to outlive
  them. Each entry is now `{ "receipt": "rcpt-…", "step": "create-project" }`.
  The step name is redundant with the cited receipt on purpose: a record
  that has to be joined against something else to be read is a worse record
  than one that is legible alone. Deduplication by receipt id and first-read
  ordering are unchanged, as is omitting the key entirely when nothing was
  read. `used` also now covers every way a value can be drawn from an
  earlier execution — a `from` injection and a `nuka do --use` receipt, not
  only a `ctx.resultOf` call. **This is a breaking change** for anything
  reading `used` out of a receipt or out of the Allure report's "used
  receipts" parameter.
- **`nuka steps`' text output is formatted for a terminal.** It was one
  tab-separated line per step, which real vocabularies push to 120-145
  characters; an 80-column terminal soft-wraps that with no indentation, so
  a reader cannot tell where one step's row ends. Output is now one
  blank-line-separated block per step, wrapped to the terminal's width,
  with continuation lines indented one step deeper. Wrapping happens at
  space boundaries only and a single over-wide word is left unsplit, since
  a pattern is a cucumber-expression or a regex and splitting one mid-word
  makes it uncopyable. **This is a breaking change for anything parsing
  that output** — `--json` is unchanged and is the machine-readable path.

### Fixed

- **`ctx.request()` no longer requires a `baseURL`.** It threw when
  `config.baseURL` was unset while `ctx.page()` on the same ctx passed the
  same undefined value through and worked. Playwright's own
  `request.newContext()` treats it as optional, so the requirement was
  nukadoko's own addition — and a suite talking to several hosts by
  absolute URL has no single baseURL to name, so satisfying it meant
  writing something untrue into the config. A step that passes a relative
  path with no baseURL configured now fails on Playwright's own call.

### Documentation

- How to actually view the report: `allure watch` (live — it re-renders as
  a run writes), `generate`, and `open`, verified against this repository's
  own results. Every command passes `--output .nukadoko/allure-report`,
  because Allure defaults that to the current directory and would otherwise
  leave a generated report in the repository root, un-ignored.
- Upgrading before 0.1 needs `npm install -D nukadoko@latest`: npm writes
  `^0.0.x`, and a caret pins the patch there, so `npm update` never moves
  off the first installed version.
- The secrets rule — git classifies env files, untracked means secret
  source, tracked means plain configuration — now appears in the README
  rather than only in the spec.
- How a step stays runnable under `nuka do` and still chains in a scenario:
  an optional argument with a `ctx.resultOf` fallback, plus the rule that
  makes it work (a schema key with no capture must be optional, and
  `nuka check` does not catch a required one).
- The spec now states that nukadoko never reconciles `mutates` against
  `observed` itself, and why automating that claim is not on the table.
- README.ja.md glosses each English heading in Japanese.

## 0.0.3 — 2026-08-03

### Changed

- **`mutates` is now a declaration nukadoko trusts, not a verdict it derives
  from measurement.** A Then-position step that observes a network write no
  longer fails, and neither does one that writes under a `read-only`
  environment. Write detection runs on HTTP method, which is a proxy for
  write semantics rather than the semantics itself: GraphQL, RPC-over-POST,
  and most vendors' query endpoints implement pure reads over POST, so a
  truthful `mutates: false` step calling one was counted as writing, barred
  from `Then`, and unusable read-only — with no escape hatch. The
  distinguishing signal is protocol-specific every time and invisible from
  the HTTP layer, so there is no general rule to widen the proxy with.
  Everything is still recorded: `observed` remains on every receipt, beside
  `mutates` in the Allure table, with every call in `http.jsonl`. A wrong
  declaration stays falsifiable after the fact, which is why trusting it is
  not the same as abandoning measurement.
- Declaration-based gates are unchanged: a `read-only` environment still
  refuses a declared mutator before it runs, and `nuka check` still warns
  when one is bound in `Then` position.

### Removed

- `then_mutated` and `read_only_violation` are gone from `ErrorKind`. Nothing
  assigns them any more, and a closed vocabulary that lists unreachable
  values is a lie about what a receipt can say. `categories.json` and the
  bundled `allurerc.mjs` ship seven rules instead of nine.

### Added

- `rationale` on `defineStep`: why a step is implemented the way it is, and
  what was rejected. Shown by `nuka describe`, never in `nuka steps`' listing
  (which stays one line per step), and never on a receipt (it describes the
  contract, not an execution).
- `ctx.requireEnv(name)` returns `string` by throwing when a variable is
  unset or empty, so a step reading a required value stops writing its own
  presence check — and stops phrasing the failure differently in every
  project, which matters when agents are the ones reading it.
- `ctx.section(label)` marks a stage inside a step; the receipt carries
  `sections`, the labels in call order. A failed step's array ends at the
  last stage it entered, so a long step finally says where it stopped.
- `nuka init --features-dir <dir>` for a project that doesn't use the
  default layout, writing `featuresDir` into the generated config as well as
  creating the directory.
- `nuka check` reports a glue file it cannot import (`step-file-import-failed`,
  carrying Node's own message) and keeps checking the rest of the project,
  instead of dying on the first one. It also reports unsupported hook tag
  expressions. A migrating suite's normal state is "some glue is still
  broken", which is exactly when a migration dashboard has to keep working.
  The undefined-step errors that a missing file's vocabulary would cause are
  suppressed while any import failed, with a warning saying how many were
  held back.
- `config.browser` takes Playwright's own `LaunchOptions` and passes it to
  `chromium.launch`. It was `unknown` before, with only `headless` read out
  of it, so anything else written there was silently ignored.
- `nukadoko/compat` exports `Status`, `AfterStep`, `IWorldOptions`, and
  `ITestCaseHookParameter` — every remaining name the compat audit counted
  except `setParallelCanAssign`, which stays unsupported by decision:
  nukadoko has no parallel execution, so accepting the call would leave a
  suite believing a rule was in force while nothing enforced it. `AfterStep`
  runs once per executed step (never for a step that was skipped) and its
  record entry carries `step_index`.

### Fixed

- `poll`'s signature said `fn` and `poll` returned the same type, while the
  implementation treats `undefined` as "not ready yet". Passing
  `() => Promise<Job | undefined>` therefore typed `poll` as possibly
  returning `undefined`, which it cannot do, and callers under `strict` had
  to assert it away. Only the parameter type changed; the body is untouched.
- `nuka check`'s `parameter-type-support-origin` reported an absolute path in
  `file` where every other issue reports one relative to the project root.

### Packaging

- `docs/` ships in the tarball. The README and the migration guide both link
  to `docs/spec.md` relatively, and from an installed copy those resolved to
  nothing — which undercut the one thing this package says about itself,
  that the design and its limits live in a single place you can reach.
  `examples/` stays out (316K, and it carries generated artifacts); links to
  it are absolute now.

## 0.0.2 — 2026-08-03

### Fixed

- `nuka --version` printed the version of whichever project was running the
  CLI rather than nukadoko's own. yargs was never told a version, so its
  default resolution walked up from the current working directory: a
  consumer whose package.json said `9.9.9` got `9.9.9`, and one with no
  version field got `unknown`. It now reads this package's own
  package.json, resolved from the module's own location.

### Added

- The cucumber-messages `meta` envelope carries `implementation.version`.
  It was omitted in 0.0.1 only because nothing here could read the
  package's own version at runtime, which is the same gap the fix above
  closed.

## 0.0.1 — 2026-08-03

First published version. Covered by 523 tests.

### Typed steps

- `defineStep` with zod schemas for `args` and `returns`, validated at the
  run boundary, and named capture (`{name:string}`) so reordering two
  same-typed values in a pattern cannot silently swap them.
- `ctx.resultOf(step)` reads a previous step's validated result by the Step
  object's identity rather than by name, which makes the dependency a static
  import as well as a receipt entry.
- `mutates` is declared per step and checked against what the run observed:
  a Then-position step that writes fails on the measurement, not on the
  declaration.

### Receipts

- Every execution writes a receipt: the validated result, the network reads
  and writes the tool itself observed, evidence, environment, and target
  version.
- `nuka accept` freezes one green run as a committed record beside its
  feature. Execution and sign-off stay separate commands; failing runs are
  not recorded.

### Running

- `nuka init`, `scaffold`, `steps`, `describe`, `do`, `check`, `run`,
  `accept`, `session`, and `skill path`. Every command has a `--json` form
  or machine-readable output where it makes sense.
- `nuka check` reports duplicate patterns, ambiguous steps, undefined steps,
  and bare `{string}` captures before anything runs.
- Sessions, environments (`--env`), and secrets loaded from configured env
  files.

### Compat

- `nukadoko/compat` runs an existing cucumber-js suite by switching one
  import, keeping pattern syntax, hooks, and the World working while
  receipts are measured underneath. Switching the import back returns a
  plain cucumber-js suite.
- ESM only: `require("nukadoko/compat")` fails outright, so a CommonJS suite
  needs a module-format change first.

### Reports

- Allure emitter, filling the report from receipts with no per-project hook
  wiring, including the validated per-step result that classic Cucumber
  discards.
- cucumber-messages (NDJSON) emitter, so existing formatters and JUnit-based
  CI keep working.

### Skills

- Two skills following the [Agent Skills specification](https://agentskills.io/specification):
  `acceptance` (a ticket's criteria through to a committed record) and
  `migration` (moving a cucumber-js suite across in two stages). Neither
  writes down what the CLI can answer.

### Not in this release

Compat gap detection in `nuka check`, an AI-assisted glue converter, and
scenario harvesting. See the [roadmap](docs/spec.md#roadmap).
