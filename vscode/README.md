# nukadoko for VSCode

Syntax highlight for [nukadoko](https://github.com/meganemura/nukadoko), an
agent-first engine that runs Gherkin with typed step contracts.

## What this extension does today

- Highlights `.feature` files: `Feature`/`Background`/`Scenario`/`Scenario
  Outline`/`Rule`/`Examples`, `Given`/`When`/`Then`/`And`/`But`, `@tags`, `#`
  comments, `"""`/```` ``` ```` doc strings, `| table |` cells, and
  `<placeholder>` references.
- Highlights the `{key:type}` capture syntax nukadoko adds to a step
  `pattern` string, inside a TypeScript file's string literals.
- Go to definition: from a step line in a `.feature` file, jumps to the
  `defineStep`/compat `Given`/`When`/`Then` declaration that step binds to.
  A step matching more than one declaration offers every match. A pattern
  this extension cannot resolve statically (built from a variable or a
  template with a substitution, rather than a literal string) is never
  guessed at; today that means no jump and no completion entry for it,
  the same as a step with no declaration at all. The declaration itself
  still gets a diagnostic, described below, so this case is never silent.
- Completion: suggests every statically-resolved pattern while typing a step
  line.
- Static-unresolved diagnostics: a step declaration with a pattern this
  extension cannot read without running the file (a variable, a function
  call, or a template literal with a substitution) gets a warning on its
  own line. This warning appears on open or save; no command run is
  needed. It comes from the same static parse as Go to definition and
  Completion, never from a `nuka` process -- unlike the `nuka check`
  diagnostics below.
- Diagnostics: the `nukadoko: Check` command (Command Palette) runs `nuka
  check --json` in the open workspace and shows its errors and warnings as
  diagnostics. This is the one command this extension ever runs workspace
  code for, and only when explicitly invoked -- see "What this extension
  does not do" below.

## What this extension does not do

This extension never runs code from the workspace it is open in on its
own: opening a file, coloring it, jumping to a definition, offering a
completion, and showing a static-unresolved diagnostic never import a step
file or spawn a process. The one exception is the `nukadoko: Check`
command above, which runs only when a user explicitly triggers it, never
on open or on save, and only ever runs `nuka` -- the workspace's own
dependency, found at `node_modules/.bin/nuka` -- never anything else the
workspace owns.

Reformatting, an outline view, generating a step from a feature line, a
step's own callers, running a scenario from the editor, and localisation
are not in this release.

## Status

Version 0.1.0. This extension is not yet published to a marketplace. Install
the `.vsix` produced by `npm run package` in this directory.

## License

MIT. See `LICENSE`.
