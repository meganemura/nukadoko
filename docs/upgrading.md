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

## Unreleased

Four breaking changes. Each entry says what to fix; why is in
[CHANGELOG.md](../CHANGELOG.md) under `## Unreleased`.

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
- **An existing acceptance record needs re-creating.** `nuka run` the
  feature again and `nuka accept` it. `nuka tend` names any acceptance
  record it finds still in the old shape (`signoff-record-old-format`).

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
