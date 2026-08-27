# Changelog

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
