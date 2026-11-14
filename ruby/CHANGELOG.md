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

### Changed

- `nuka run` checks only the scenarios it selected, as the TypeScript
  engine does, and a run stopped by `check` exits 2 with `check-errors`.
- A program file whose `environments` declare no `conditions` and that has
  no `defaultEnvironments` runs `default` alone, as the TypeScript engine
  does, rather than every environment.

## [0.1.0] - 2026-11-14

### Added

- The first Ruby engine: steps written as Ruby classes with typed `args` and
  `returns`, `nuka check`, `nuka run`, `nuka steps`, `nuka describe`, and
  `nuka sig` for Steep. It passes every case under `conformance/`.
