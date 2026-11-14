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
- A control's proof runs come after every scenario of the pass has run
  once, as in the TypeScript engine, rather than right after the control's
  first run.

## [0.1.0] - 2026-11-14

### Added

- The first Ruby engine: steps written as Ruby classes with typed `args` and
  `returns`, `nuka check`, `nuka run`, `nuka steps`, `nuka describe`, and
  `nuka sig` for Steep. It passes every case under `conformance/`.
