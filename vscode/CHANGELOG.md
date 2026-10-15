# Changelog

## Unreleased

- Go to definition, completion, and the static-unresolved warning now
  read the same step files `nuka` loads: `.ts`, `.mts`, `.js`, and `.mjs`.
  A `.mts`, `.js`, or `.mjs` step file was not read before. A `.tsx` file
  and a `.d.ts` or `.d.mts` declaration file are no longer read, because
  `nuka` never loads a step from one.
- `nukadoko: Check` shows an error when the output of `nuka check --json`
  is not a report, and names its first line. A step file that prints
  when it is imported caused this. The command failed with no message
  before and kept the diagnostics of an earlier run; it now clears them.

## 0.1.0

- Syntax highlight for `.feature` files and for the `{key:type}` capture
  syntax inside a step's `pattern` string.
- Go to definition from a `.feature` step line to its
  `defineStep`/compat `Given`/`When`/`Then` declaration.
- Completion of statically-resolved step patterns while typing a step line.
- A `nukadoko: Check` command that runs `nuka check --json` in the open
  workspace and shows its report as diagnostics -- the one command this
  extension ever runs workspace code for, and only when explicitly
  invoked.
- A warning diagnostic on any step declaration whose pattern cannot be
  read statically, refreshed on open and on save, without running any
  workspace code.
