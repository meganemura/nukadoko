# Upgrading nukadoko

For a project already running on nukadoko, moving to a newer release.
Coming from a cucumber-js suite instead? See
[docs/migration.md](migration.md); that door and this upgrade are
different questions for different readers.

## How to upgrade, every time

This part does not change release to release.

- **The completion condition is `nuka check` reporting green, not `tsc`
  passing.** A step can stay completely type-valid under `tsc` and still be
  refused by `nuka check`: a step's `run()` that takes an undestructured
  first argument, for one, typechecks fine but is rejected outright, since
  `check` reads a step's static shape more strictly than the type system
  does. `tsc` clean is not the signal to stop upgrading; `nuka check` green
  is.
- **`nuka steps` and `nuka describe` still read the vocabulary mid-upgrade.**
  One step file that fails to import does not take either command down:
  what discovery could still read comes back, and what it could not is
  named on stderr and in `import_failures` (`nuka steps --json`'s top level
  is `{ steps, import_failures }`, not a bare array).
- **`needs_inferred` reads even from a step nobody has touched yet.** A
  step whose `run()` still takes an undestructured first argument gets a
  best-effort `needs_inferred` list, read lexically from that argument's
  own member accesses, so a fixture inventory does not have to be built by
  hand while the upgrade is in progress.
- **`nuka check`'s findings are grouped, not repeated.** A finding that
  applies to more than one file (`step-file-import-failed`, for instance)
  prints its message once, followed by the sorted file list, instead of
  once per file.
- **Order**: upgrade the package, run `nuka check`, fix what it names, run
  `nuka run`, repeat until both are green.

## 0.11.0 to 0.12.0

Additions, one fix, and one name.

- **New acceptance records are named `<feature-filename>.<date>-<sha>...`,
  extension included.** Records already written keep their old name and
  keep working: nothing reads a record by its name. A script that globs
  `<basename>.*.md` matches both forms; one that globs `<basename>.20*.md`
  matches only the old one and needs `<basename>.feature.*.md` as well.
- **A step can take one key from `from` and another from a table or
  docstring on the same line.** A suite that had made the chained key
  optional to get past `table-docstring-key-mismatch` can make it required
  again, which restores the from-order check for that step.
- **`nuka run --repeat <n>`, `nuka tend --fail-on <code>`, and the Condition
  section's declared-vs-observed count** are additions; nothing already in
  place changes.

## 0.10.1 to 0.11.0

`nuka run` now removes old records on its own, and a trace file exists once
on disk instead of twice.

- **The first `nuka run` after upgrading removes every run older than the
  newest 20.** Runs are read from the scenario records already on disk,
  so a state directory that grew for weeks shrinks at the end of that first
  run, and the run prints one `retention:` line saying how many runs went.
  If that is not wanted, set `retention.runs` in `nukadoko.config.ts`
  before running; there is no "keep everything" value, only a larger
  number. `retention.adHocDays` (default 7) is the separate lifetime of a
  record no run owns, such as a `nuka do` record.
- **`nuka accept` and `nuka tend` see only the retained runs.** A feature
  whose last green run is older than the newest `retention.runs` runs now
  reads as never run; run it again before accepting it. Sign-off records
  already written are unaffected: they live beside the feature, not under
  `.nukadoko/`.
- **`nuka do --use <id>` and `nuka harvest <id>` can now refuse an id that
  used to resolve.** The refusal says the record may have aged out and
  names the policy in force, rather than only "no such step record".
- **`allure-results/` written by 0.10 and earlier is not pruned.**
  Retention removes an export file only through the manifest the run that
  wrote it left under `.nukadoko/records/runs/<run_id>/`, and older runs
  left none. Run `nuka clean --export` once to drop that directory; every
  run from now on removes its own files when it ages out.
- **A trace or screenshot under `allure-results/` is now a hard link to
  the file under `records/steps/<id>/`.** Nothing reads differently.
  Copying `.nukadoko/` with a tool that does not preserve links makes two
  files again, as before; `allure.resultsDir` on another filesystem falls
  back to a copy on its own.
- **`nuka clean --records` also removes `.nukadoko/records/runs/`.** A
  project that scripted a clean by path should include that directory.

## 0.10.0 to 0.10.1

One fix, with two things a project could notice.

- **A record's own object keys can now read differently.** `redact` used to
  walk object values and copy keys through untouched, so a secret spelled
  inside a key reached a step record verbatim. Keys go through the same
  replacements now. A script that reads a record by a key holding a secret
  was reading a leaked secret; it now reads `{{secret.NAME}}` in that
  position. Nothing else about a record moves, and the fixed-shape fields
  never carried a secret in a key to begin with.
- **`redact` can now throw where it silently dropped data before.** Two
  distinct keys can redact to one string, and the old code would have let
  the second overwrite the first and take a whole subtree with it. It
  throws and names both keys instead. The shape that reaches this is one
  key already spelling `{{secret.TOKEN}}` as ordinary data beside a sibling
  holding the raw value that token stands for. A run that hits it was
  losing data before this release without saying so.

## 0.9.0 to 0.10.0

`nuka run` writes more on stderr, and `nuka tend` reports one new note.
Why is in [CHANGELOG.md](../CHANGELOG.md) under `## 0.10.0`.

- **`nuka run` names each failed scenario on stderr, after the summary
  line.** One line per scenario that did not pass, carrying its feature
  path, line, and name, and `--quiet` keeps them the same way it keeps the
  summary. Anything parsing this command's stderr sees lines it has not
  seen before. stdout is unchanged: still one scenario record per line,
  and still the channel to parse.
- **`nuka tend` gains a `repeated-scenario-prefix` note.** It never
  changes the exit code, like every tend finding except sign-off
  staleness, so a periodic job that acts on tend's exit status is
  unaffected.

## 0.8.0 to 0.9.0

The acceptance record has one breaking change. `nuka tend`'s
`post-navigation-read` note also reads from a different place now. Why is
in [CHANGELOG.md](../CHANGELOG.md) under `## 0.9.0`.

- **A record `nuka accept` writes from now on drops `actions`,
  `page_events`, `sections`, `polls`, `declared`, `http_omitted`, and
  `truncated` from each step.** A script reading a newly accepted record
  needs to stop expecting these keys. Every one of them still lands on
  the step record under `.nukadoko/`; only the copy embedded in the
  committed record narrows. The committed record's own text names each
  key it dropped, so a reader is never left guessing.
- **A record already committed keeps working, unchanged.** Reading an
  existing acceptance record needs no change.
- **Each scenario in a record written from now on also carries a summary
  table**: step, status, ms, mutates, reads, writes.
- **`nuka tend`'s `post-navigation-read` note now reads step records under
  `.nukadoko/records/steps/`, not a committed one.** Nothing to do on the
  project side. To get the note back for a step, run the feature again.

## 0.7.0 to 0.8.0

The Allure report structure has one breaking change. One other behavior
change affects consumers of `nuka tend --json`.

- **Allure now writes one result for each scenario pickle.** Gherkin steps
  are entries inside that result. The Suites tab no longer groups results
  by `parentSuite` and `suite`, so a saved Suites view appears flat.
  Find Features in the Behaviors tab through the `feature` label, or use
  the result's `titlePath` hierarchy. A plain scenario keeps its existing
  history. Each Scenario Outline row starts a new history once because
  its Examples cells are now visible parameters. Live reports still
  update after each step, but temporary progress snapshots now provide
  those updates. During a live session, a running scenario's retries can
  show older unknown snapshots. Nukadoko removes them when the scenario
  ends, so they do not appear in a report generated after the run.
  A consumer that reads `allure-results` during a run must treat
  `*-progress-result.json` as a temporary file. These files do not exist
  after a completed run.

- **`nuka tend`'s `post-navigation-read` notes are grouped now.** One note
  used to be emitted per step record, so a Background step in a suite with
  two dozen scenarios produced two dozen notes that differed only by file
  name. Matches that share a step, its navigation call, and the call that
  followed it are one note now, carrying how many step records it happened
  in and the range the gaps fell in. A script that counted notes to count
  occurrences counts distinct shapes instead; the occurrence count is in
  the note's own text.

## 0.6.0 to 0.7.0

One breaking change, plus a behavior change that is not breaking but is
worth knowing about, since it changes what a script watching `nuka run`'s
output actually sees. The breaking one: why is in
[CHANGELOG.md](../CHANGELOG.md) under `## 0.7.0`.

- **An args key a step's schema does not declare is refused now, not
  silently dropped.** `nuka describe` already published each object
  schema's own `additionalProperties: false`; the runtime now enforces
  the same shape everywhere a step can be called: `nuka do`, `nuka do
  --session <live>`, `nuka run`, `recordStep`, and the `call`
  fixture a part is invoked through. A key `from` or `--use` fills is
  never flagged, since either can only ever name a key the step already
  declared. **A successful step record's own `args` also changed shape**:
  it is now the schema-validated value, not the raw one, so a key filled
  by the schema's own `.default(...)` shows up in it even where the
  caller never typed it. A script comparing a step record's `args`
  against what it sent needs to allow for that: an added default is not a
  sign anything went wrong. A failed record is unaffected, and neither is
  a part's own `CallEntry.args`, which stays raw on both outcomes either
  way.
- **Not breaking, but worth knowing: `nuka run` no longer writes straight
  into `messages.output` while a run is in progress.** Each invocation now
  writes its own file (the configured path's own name with the run id
  spliced in, `messages.<run_id>.ndjson` under the default path) beside
  the configured path, and only replaces the configured path, atomically,
  once the run finishes; the change closes a real bug where two `nuka run`
  invocations against the same path used to interleave into one broken
  file. A script
  that tailed `messages.ndjson` to watch a run live no longer sees
  anything until the run ends; watch Allure instead (`npx allure watch`)
  for that. A script that treated the file being truncated as "a run just
  started" needs a different signal, since the configured path is not
  touched until the run's own end now. `messages.output` still ends up
  holding the newest completed run's own stream either way, so nothing
  that only reads it once the run is done needs to change. One thing to
  add to housekeeping: each run's own file accumulates beside the
  configured path now, removed only by `nuka clean [--export]`, a new
  command this release also adds (see the command's own `--help`).

## 0.4.1 to 0.5.0

Additive, with one narrow exception. Why is in
[CHANGELOG.md](../CHANGELOG.md) under `## 0.5.0`.

- **`Step` now always carries `parts`, so a hand-written `Step` object
  literal no longer typechecks.** `Step` is an exported type and `parts`
  is required on it, the same way `from` already is, so every reader can
  iterate it without checking for `undefined` first. Nothing built by
  `defineStep` is affected, and neither is code that only annotates or
  passes a `Step` around; the one thing that breaks is constructing the
  object by hand, which a test double is the usual reason to do. Add
  `parts: []` to it, or better, build it with `defineStep`.
- **Nothing else needs doing.** A step record gained an optional `calls`
  field, `nuka steps --json` and `nuka describe` gained `parts`, and
  `needs`/`needs_browser` now account for a step's parts. No field was
  renamed or removed, so an existing acceptance record stays valid and a
  script reading either JSON keeps working.

## 0.3.0 to 0.4.0

One breaking change, plus one action that is not breaking. Each entry
says what to fix; why is in [CHANGELOG.md](../CHANGELOG.md) under
`## 0.4.0`.

- **A step record's and a scenario record's id-bearing field names
  changed again, following one rule now: `<grain>_record_id`, or `run_id`
  for a run.** A script reading either JSON needs the current names: a
  step record's `record_id` is `step_record_id`; the owning scenario
  record's id on a step record, formerly `scenario`, is
  `scenario_record_id`; a scenario record's own `scenario_id` is
  `scenario_record_id`; a scenario record's `steps[].record` is
  `steps[].step_record_id`. A scenario record's own `scenario` field (the
  pickle's name, never an id) and `run_id` did not change, and neither
  did the `step-`/`scn-`/`run-` id prefixes. An existing acceptance
  record may need re-creating: `nuka run` the feature again and `nuka
  accept` it. Run `nuka tend` before upgrading to find out whether yours
  does, rather than assuming: it names every acceptance record that is
  actually affected (`signoff-record-old-format`), and names none for a
  feature that already lives inside `featuresDir`, since that feature
  runs unattended and its sign-off is no longer what carries the
  guarantee. Two more spots
  followed the old, bare convention and now match the same rule: a step
  record's `used[]` entries carried the upstream id under `record`,
  formerly; a script reading it needs `used[].step_record_id` now. And
  the Allure emitter's step parameter that used to be named just
  `"record"` is `"step record id"` now, so a script parsing Allure
  output by parameter name needs the new label.
- **Not breaking: a step record now also carries `run_id: string |
  null`.** Nothing stops working without reading it. A script that wants
  to know which run a step record belongs to, without opening the
  scenario record beside it first, can read this field instead.

## 0.2.0 to 0.3.0

Five breaking changes, plus one action that is not breaking but is needed
to opt in to a new capability. Each entry says what to fix; why is in
[CHANGELOG.md](../CHANGELOG.md) under `## 0.3.0`.

- **A step record's JSON changed field names and id prefix.** A script
  reading a step record's or scenario record's JSON needs the current
  names: `receipt_id` is now `record_id`, an id starts `step-` rather
  than `rcpt-`, and a `used` entry's upstream key is `record`, not
  `receipt`.
- **`.nukadoko/` now splits into three directories, by purpose:
  `records/`, `export/`, and `cache/`.** A step record's own directory is
  now under `records/steps/<id>/`, a scenario record's under
  `records/scenarios/<id>/`; the Allure and messages emitters now write
  under `export/`; a session now lives under `cache/sessions/`.
  `.nukadoko/` is gitignored working state, so the old directories can
  simply be deleted; the next `nuka run` writes the new layout, nothing
  needs migrating out of them.
- **`--use` takes a `step-...` id now.** An id minted before this release
  points at a directory layout the tool no longer reads; re-run the
  producing step (`nuka do` or `nuka run`) to get one in the current
  shape.
- **An existing acceptance record may need re-creating.** Run `nuka
  tend` before upgrading and let it answer: it names every acceptance
  record actually affected (`signoff-record-old-format`), and names none
  for a feature inside `featuresDir`, whose sign-off it stopped
  reporting on in 0.3.0. For the ones it names, `nuka run` the feature
  again and `nuka accept` it.
- **`nuka tend` stops reporting a stale sign-off or a drifted condition
  for a feature that already lives inside `featuresDir`.** If a project
  relied on that finding for such a feature, the coverage moved: running
  that feature, already running unattended, is what confirms the same
  thing now. `signoff-record-unreadable` is unaffected. No code change is
  needed either way.
- **Not breaking, but needed to opt in: a project with its own
  `allurerc.mjs` needs `historyPath` added by hand to get Allure's
  history, trend, and flaky-across-runs views at scenario grain.** Nothing
  stops working without it, the same as before this release; the new
  scenario-level Allure test result just never shows up in those views.
  Add `historyPath: ".nukadoko/export/allure-history.jsonl"` (adjusted if
  `stateDir` in `nukadoko.config.ts` points elsewhere) alongside the
  existing `categories` array; `examples/allure/allurerc.mjs` shows the
  field in place. A project created with `nuka init` on this release
  already has it.

## 0.1.0 to 0.2.0

Three breaking changes. Each entry says what to fix; why is in
[CHANGELOG.md](../CHANGELOG.md) under `## 0.2.0`.

- **`nuka steps --json`'s top level changed from a bare array to `{ steps,
  import_failures }`.** Anything reading the old bare array needs to read
  `.steps` now; `import_failures` (`{ file, message }`) is new alongside
  it, always present, `[]` when nothing failed.
- **Allure now writes one test per step, not one test per scenario.** A
  report's test count is now a step count, not a scenario count. Read a
  scenario's own pass/fail from its `suite` row, not from a single test.
  Allure's history, trend, and flaky-across-runs views no longer work: if
  CI carried `history.jsonl` forward from a run's generated report into
  the next run's `allure-results/`, that carry-forward no longer does
  anything, since nothing in this emitter's output links a step to itself
  in an earlier run.
- **`nuka steps` now exits non-zero when the project has no features
  directory.** A script that ran it outside a nukadoko project, or after
  `featuresDir` was renamed without the config following, used to get an
  empty vocabulary and a clean exit. It now gets the resolved path it
  looked for on stderr and a non-zero exit, with nothing on stdout. If a
  pipeline was relying on the clean exit, point it at the right directory
  or fix `featuresDir` in `nukadoko.config.ts`. A project whose features
  directory exists but holds no steps is unaffected, and still exits `0`.

## 0.0.5 to 0.1.0

Three breaking changes. Each entry says what to fix; why is in
[CHANGELOG.md](../CHANGELOG.md) under `## 0.1.0`.

- **A typed step's `run` takes a fixture bag now, not `ctx`.** Collect
  every `ctx.foo` a step reads into a destructured first argument
  (`run({ page, section }, args)`), then drop `await` and the call
  parentheses on `page`/`request`: they are values now, not functions. No
  codemod ships for this.
- **`evidence.trace` moved off the scenario record onto each step's own
  record.** Anything reading the scenario record's `evidence.trace` needs
  to read the step record of the step that opened a page instead.
- **A sign-off record's filename now carries its condition.** Anything
  reading the old `<feature-basename>.<date>-<sha>.md` shape needs to read
  `<feature-basename>.<date>-<sha>.<environment>.<browser>.md` instead.

## Before 0.0.5

See [CHANGELOG.md](../CHANGELOG.md).
