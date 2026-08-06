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

One breaking change. The entry says what to fix; why is in
[CHANGELOG.md](../CHANGELOG.md) under `## Unreleased`.

- **`nuka steps --json`'s top level changed from a bare array to `{ steps,
  import_failures }`.** Anything reading the old bare array needs to read
  `.steps` now; `import_failures` (`{ file, message }`) is new alongside
  it, always present, `[]` when nothing failed.

## 0.0.5 to 0.1.0

Three breaking changes. Each entry says what to fix; why is in
[CHANGELOG.md](../CHANGELOG.md) under `## 0.1.0`.

- **A typed step's `run` takes a fixture bag now, not `ctx`.** Collect
  every `ctx.foo` a step reads into a destructured first argument
  (`run({ page, section }, args)`), then drop `await` and the call
  parentheses on `page`/`request`: they are values now, not functions. No
  codemod ships for this.
- **`evidence.trace` moved off the scenario record onto each step's own
  receipt.** Anything reading the scenario record's `evidence.trace` needs
  to read the receipt of the step that opened a page instead.
- **A sign-off record's filename now carries its condition.** Anything
  reading the old `<feature-basename>.<date>-<sha>.md` shape needs to read
  `<feature-basename>.<date>-<sha>.<environment>.<browser>.md` instead.

## Before 0.0.5

See [CHANGELOG.md](../CHANGELOG.md).
