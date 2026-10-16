# Changelog

## Unreleased

- Go to definition, completion, and the static-unresolved warning now
  read the same step files `nuka` loads: `.ts`, `.mts`, `.js`, and `.mjs`.
  A `.mts`, `.js`, or `.mjs` step file was not read before. A `.tsx` file
  and a `.d.ts` or `.d.mts` declaration file are no longer read, because
  `nuka` never loads a step from one. The package no longer ships the TSX
  grammar.
- The step index skips `build`, `coverage`, and `.next` as well as
  `node_modules`, `dist`, `out`, `.git`, and `.nukadoko`. A file written
  under one of them no longer rebuilds the index, so an `npm install` or
  a bundler in watch mode does not start a re-index for each file it
  writes.
- `nukadoko: Check` shows an error when the output of `nuka check --json`
  is not a report, and names its first line. A step file that prints
  when it is imported caused this. The command failed with no message
  before and kept the diagnostics of an earlier run; it now clears them.
  A run that prints nothing gets its own error saying so.
- Completion inserts a snippet with one tab stop per parameter instead
  of the raw pattern, which matched no step. Each stop starts with a
  value of the parameter's type, optional text is left out, and the first
  alternative of `a/b` is kept, so the inserted line binds to its step.
- A step file the index cannot read or parse gets a warning on its first
  line, and the other files stay indexed. One such file made Go to
  definition and completion fail for the whole workspace before. A
  failure to list the workspace shows an error message.
- `vsce package` builds `dist/` first, so a package made from a clean
  checkout holds the extension's code.

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
