# Changelog

Notable changes to the `nukadoko` gem, the Ruby engine. The npm package has
its own changelog, `../CHANGELOG.md`, and its own versions. Each release's
notes come from the section below whose heading starts with `## [<version>]`.

## [Unreleased]

### Added

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

### Changed

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

## [0.1.0] - 2026-11-14

### Added

- The first Ruby engine: steps written as Ruby classes with typed `args` and
  `returns`, `nuka check`, `nuka run`, `nuka steps`, `nuka describe`, and
  `nuka sig` for Steep. It passes every case under `conformance/`.
