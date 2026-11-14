# Conformance cases

Each case is one small project that every nukadoko engine must judge the same way.
The TypeScript engine is the reference: its result is the case's `expected.json`.

```
cases/<name>/
  features/      the feature files, shared by every engine
  steps-ts/      the steps for the TypeScript engine
  steps-rb/      the same steps for the Ruby engine
  program.json   how to start the program under test; {root} is this repository
  files/         optional: files copied to the project root, such as the program a step runs
  config.ts      optional: the TypeScript engine's nukadoko.config.ts, for fixtures the case declares
  config.rb      optional: the same for the Ruby engine, after the line that names the browser
  expected.json  the findings of check, and the verdict of each scenario and step
```

`expected.json` holds only what both engines must agree on.
Each step is compared as `nuka steps --json` and `nuka describe` print it, without its file.
A finding is its severity, its code, and the feature file and line or the step name it is about.
A step is named by its step name, not its file, because each language spells step files its own way (`add-todo.ts`, `add_todo.rb`).
Messages and timings are left out.

## Commands

- `node conformance/run-ts.mjs` runs every case under the TypeScript engine and compares the result with `expected.json`. It needs `npm run build` first.
- `node conformance/run-ts.mjs --write` writes `expected.json` again. Read the diff before you commit it.
- `node conformance/run-ts.mjs <name>...` runs only the named cases.
- `ruby conformance/run-rb.rb [<name>...]` runs the cases under the Ruby engine and compares them with the same `expected.json`. Run `bundle install` in `ruby/` first.

A case whose steps use `page` launches Chromium.
When Playwright's own browser is not installed, set `NUKADOKO_CHROMIUM` to a Chromium executable, and both runners give it to their engine.
