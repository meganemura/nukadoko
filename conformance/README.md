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

- `node conformance/run-ts.mjs` runs every case under the TypeScript engine and compares the result with `expected.json`. It needs `npm run build` in `typescript/` first.
- `node conformance/run-ts.mjs --write` writes `expected.json` again. Read the diff before you commit it.
- `node conformance/run-ts.mjs <name>...` runs only the named cases.
- `ruby conformance/run-rb.rb [<name>...]` runs the cases under the Ruby engine and compares them with the same `expected.json`. Run `bundle install` in `ruby/` first.
- `node conformance/run-engine.mjs [<nuka run argument>...]` runs the scenarios under `engine/` (below). `--env typescript` or `--env ruby` runs them against one engine.

## What nuka itself does

A case holds what a run of one project concludes. What the `nuka` command does with its arguments (which scenarios a target and `--tag` select, which worlds `--env` starts, which mistakes it refuses, with which code and fix, and what `summary.md`, `nuka report`, `nuka verdict`, and `nuka clean` say) is not a case's result, so it lives in `engine/` as scenarios.
`engine/` is a nukadoko project of its own, run by the TypeScript engine.
Its program file has two worlds, `typescript` and `ruby`, so every scenario runs once against each engine, and a behavior holds only when both show it.
A scenario builds a project from `engine/projects/<name>/` (its `features/`, and `steps-ts/` or `steps-rb/` for the engine at hand), runs that engine's `nuka` in it, and claims on the exit code and the `--json` envelope.
Where `docs/spec.md` says what the TypeScript engine does, a scenario restates it.
Where it does not, the scenario is where the behavior is written down, and the TypeScript engine is what it was read from.

A case whose steps use `page` launches Chromium.
When Playwright's own browser is not installed, set `NUKADOKO_CHROMIUM` to a Chromium executable, and both runners give it to their engine.
