# Adding nukadoko to an existing project

This guide takes a project that already has code and unit tests to its
first scenario that runs green, in CI, with a run summary on the pull
request. It assumes a Node project; a repository without a `package.json`
starts with the note under [Setup details](../README.md#setup-details).

Each step names the command and what it writes. The outputs below are
copied from a real run of the packed package in a scratch project whose
CLI, `src/cli.ts`, prints `Hello, <name>!`. The README walks the same
project with every file shown in full: see
[Beside your unit tests](../README.md#beside-your-unit-tests).

## 1. Install nukadoko

You need Node 22.18 or later on the 22 line, or 23.6 or later. Install
nukadoko as a devDependency, pinned to one exact version:

```sh
npm install -D -E nukadoko
```

`-E` writes `"nukadoko": "0.17.0"` instead of a caret range. While
nukadoko is 0.x, any release can change the public API, so move to a new
version on purpose and read [docs/upgrading.md](upgrading.md) when you do.

Steps that use `page` or `request` need Playwright. A CLI project does
not. To add it, follow [Install](../README.md#install).

## 2. Run `nuka init`

Run it from the directory that holds the project's `package.json`:

```sh
npx nuka init
```

```text
nukadoko.config.ts
features/steps
.gitignore
package.json
tsconfig.json
next: read node_modules/nukadoko/llms.txt, written for an agent: the loop, every command, and every finding code
```

`init` writes `nukadoko.config.ts` and `features/steps/`, and adds lines
to three files:

- `.gitignore` gains `.nukadoko/` (the state directory) and `.env`,
  `.env.*`, and `!.env.example`.
- `package.json` gains `"test:scenarios": "nuka run"`, the one command a
  person or CI runs.
- `tsconfig.json` gains `features/**/*` and the config file when its
  `include` leaves them out, and `"rewriteRelativeImportExtensions": true` when it names
  neither that option nor `allowImportingTsExtensions`.

Decide the optional flags now. `nuka init` refuses to run again once
`nukadoko.config.ts` exists.

- `--allure` writes `allurerc.mjs`, which sorts failures into Allure
  categories. Without it, copy
  [examples/allure/allurerc.mjs](https://github.com/meganemura/nukadoko/blob/main/examples/allure/allurerc.mjs) by hand.
- `--server "<command>" --server-url <url>` writes a fixture that starts
  your server for each scenario that sends a request. See
  [A server you start yourself](../README.md#a-server-you-start-yourself).

A CommonJS project (no `"type": "module"`) gets `nukadoko.config.mts`
instead; its step files also need `.mts`.

## 3. Write the first feature

Write one scenario for one behavior someone asked for, in their words,
and save it as `features/greet.feature`:

```gherkin
Feature: greet

  Scenario: greets by name
    When I run greet with "Ada"
    Then the output says "Hello, Ada!"
```

## 4. Check it, then scaffold the missing steps

`nuka check` reads every feature and step file and runs nothing:

```sh
npx nuka check
```

```text
error	undefined-step	features/greet.feature:4	No step definition matches "I run greet with "Ada""
  do: nuka scaffold --feature features/greet.feature
error	undefined-step	features/greet.feature:5	No step definition matches "the output says "Hello, Ada!""
  do: nuka scaffold --feature features/greet.feature
```

Run the `do:` line. It writes one stub for each line that no step
matches, and prints the command that redoes each stub with more options:

```sh
npx nuka scaffold --feature features/greet.feature
```

```text
features/steps/i-run-greet-with.ts
features/steps/the-output-says.ts
next: redo a stub in place with its line below, adding --command, --request, --from, or --description; --replace overwrites the stub while nobody has edited it:
  nuka scaffold i-run-greet-with --pattern 'I run greet with {value:string}' --replace
  nuka scaffold the-output-says --pattern 'the output says {value:string}' --then --replace
```

A stub throws `not implemented` until you fill it in. For the common
shapes, redo it with an option instead of editing it:

- `--command <entry point>` makes a When step that runs your program in
  an empty directory and returns `exitCode`, `stdout`, and `stderr`.
- `--request "<METHOD> <path>"` makes a When step that sends one HTTP
  request and returns `status` and `body`.
- `--then --from <step>.<key>` makes a Then step that compares a value an
  earlier step returned with the capture on its line.

Rename a capture in the pattern to name what it holds:

```sh
npx nuka scaffold i-run-greet-with --pattern 'I run greet with {name:string}' --command src/cli.ts --description "Run greet in an empty scratch directory" --replace
npx nuka scaffold the-output-says --pattern 'the output says {text:string}' --then --from i-run-greet-with.stdout --description "greet printed exactly this line" --replace
npx nuka check
```

```text
ok: no issues found
```

`--command` runs the entry point with `node`. If your `.ts` files import
each other with `.js` names, point it at the built program instead, for
example `--command dist/cli.js`. The README explains why under
[Beside your unit tests](../README.md#beside-your-unit-tests). For a
step that no option covers, write `run` yourself; `nuka steps` and
`nuka describe <name>` show the vocabulary you already have.

## 5. Run it

```sh
npm run test:scenarios
```

```text
> test:scenarios
> nuka run

scenario 1/1  features/greet.feature:3  greets by name
  step 1/2  passed  0.1s  I run greet with "Ada"
  step 2/2  passed  0.0s  the output says "Hello, Ada!"
steps     .nukadoko/runs/run-20261018-232314-j5x1/steps/  2
summary   .nukadoko/runs/run-20261018-232314-j5x1/summary.md
run       .nukadoko/runs/run-20261018-232314-j5x1/run.json
1 scenario: 1 passed, 0 failed  (0s)
```

`nuka run` runs `nuka check` first and stops on an error. When a scenario
fails, stderr names the step, its error, its step record, and a `do:`
line such as `nuka run features/greet.feature:3` that reruns that one
scenario.

Two flags help while you write the first scenarios:

- `nuka run --probe` runs each read-only Then again with its capture
  changed. A Then that still passes does not check what its line says.
  With `assert.ok(actual.startsWith("Hello"))` in place of the scaffolded
  comparison, the run still passes and adds a note:

  ```text
  note	then-passed-with-changed-capture	features/greet.feature:5	the output says "Hello, Ada!": step "the-output-says" passed with text "Hello, Ada!-probe" in place of "Hello, Ada!"
    fix: Make the step compare its result with the capture the message names; a step whose sentence also allows the changed value, such as "at least n", can stay as it is.
    do: nuka run features/greet.feature:3 --probe
  ```

- `nuka run --env <name>` runs against an environment that
  `nukadoko.config.ts` names under `environments`, each with its own
  `baseURL`, `envFiles`, and `policy`. An environment with
  `policy: "read-only"` refuses every step declared `mutates: true`
  before it runs. The `--command` scaffold writes `mutates: true`; set
  it to `false` when the program changes nothing outside its scratch
  directory. See
  [Environments and secrets](spec.md#environments-and-secrets).

## 6. Read the run directory

Every `nuka run` writes one directory under `.nukadoko/runs/`:

- `run.json` is the run's result: the verdict, the counts, and each
  scenario's record with its rerun command.
- `summary.md` is the Markdown run summary. On GitHub Actions it also
  goes to the job's summary page.
- `steps/<id>/record.json` is one step record: its arguments, its
  validated result, and what the tool observed, such as the processes a
  `runCommand` started. Evidence files (a trace, screenshots,
  `http.jsonl`) sit beside it.
- `scenarios/<id>/` holds a scenario's own evidence, when it wrote any.
- `sources.json` is the feature text the run parsed, and `exports` lists
  what `nuka report` wrote from this run.

By default nukadoko keeps the newest 20 runs (`retention.runs`). `nuka clean`
deletes them. Do not commit `.nukadoko/`: traces and screenshots are not
redacted. The full layout is in
[The state directory](spec.md#the-state-directory).

## 7. Render reports with `nuka report`

`nuka report` renders a finished run from its run directory alone. With
no run directory it uses the newest run.

```sh
npx nuka report --format markdown                        # the run summary, on stdout
npx nuka report --format allure                          # .nukadoko/export/allure-results/
npx nuka report --format messages --out messages.ndjson  # a cucumber-messages stream
```

Allure results need Allure 3's CLI to become a report. The commands, and
why each one takes `--output`, are in
[Reports fill themselves](../README.md#reports-fill-themselves).

## 8. Add it to CI

A CLI or API project adds one step after its unit tests:

```yaml
- run: npm run test:scenarios
```

[docs/ci.md](ci.md) has the whole workflow, the browser variant, and
how to upload the run directory and post the run summary on the pull
request.

Commit `features/`, `nukadoko.config.ts`, and the changes to
`package.json`, `tsconfig.json`, and `.gitignore`.

## Where to go next

- A coding agent loads the acceptance skill
  ([skills/acceptance/SKILL.md](../skills/acceptance/SKILL.md)).
  `nuka skill path` prints the copy that matches your installed version.
- A project with a cucumber-js suite brings it in by switching one
  import: [docs/migration.md](migration.md).
- What `nuka check` catches before anything runs:
  [Wrong before it runs](../README.md#wrong-before-it-runs).
- Every command, config key, and record field: [docs/spec.md](spec.md).

---

[Japanese](adopting.ja.md)
