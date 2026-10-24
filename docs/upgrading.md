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
  is `{ schema_version, steps, import_failures }`, not a bare array).
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
- **Across several releases, read every section from yours up, and the
  newest one wins.** Each section below describes its release as it
  shipped. A command, a flag, or an exit code that an older section names
  can have been removed or changed by a later one: in the newest release,
  a refusal exits 2, and `nuka clean` takes no `--records`, `--cache`, or
  `--export`.
- **A release with no section below needs no action.** 0.4.1, 0.6.0,
  0.13.1, and 0.14.0 are such releases. Start reading at the first section
  whose range ends above your version: a project on 0.13.0, 0.13.1, or
  0.14.0 starts at "0.14.0 to 0.14.1".

## 0.21.0 to the next release

- **`repeated-scenario-prefix` comes from `nuka run`.** `nuka tend` no
  longer reports it. Every `nuka run` adds it to its own findings as a
  note, measured from that run: it is in `run.json`'s `findings`, in
  the `--json` document, and on stderr after the count line. It never
  changes the exit code. A job that read it from `nuka tend --json` reads
  the `findings` of the run instead, and filters by `code`. A `nuka tend`
  job that lists the code in `--fail-on` drops it from the list: tend
  refuses it with `fail-on-unknown-code`.

## 0.20.0 to 0.21.0

- **The skills have new names.** `acceptance` is `nukadoko`, and
  `verification` is `nukadoko-verification`. A host that installed them
  with `gh skill install meganemura/nukadoko --all` installs again and
  removes the copies under the old names. A path written as
  `<nuka skill path>/acceptance/` becomes `<nuka skill path>/nukadoko/`.

- **The migration skill is gone.** A host that installed it with
  `gh skill install meganemura/nukadoko --all` keeps the old copy until
  it is removed; remove it, and point an agent that is moving a suite at
  docs/migration.md instead. Its "Working rules" section carries what the
  skill said.

- **Two more evidence names are the harness's.** `ctx.evidence.attach`
  and `ctx.evidence.path` refuse `process-<n>.stdout.txt` and
  `process-<n>.stderr.txt` with `ReservedEvidenceNameError`, in any case:
  nukadoko now keeps what a `runCommand` process printed under those
  names. A step that attached a file under one of them picks another
  name. A step that attached a command's output only so a reviewer could
  read it can stop: the step record already names that file.

## 0.17.0 to 0.18.0

- **`nuka run --quiet` is removed.** It is refused with `removed-flag`.
  A CI step that wanted a short log runs `nuka run --json`: stderr is
  empty, and stdout is `run.json`.

- **Markdown oaths are removed.** The `oaths` config key is refused with
  `config-key-removed`, and a `.md` target of `nuka check` or `nuka run`
  is refused with `markdown-target`. Write the scenarios of each oath as
  Gherkin in a `.feature` file under `featuresDir`, then delete the
  `oaths` key.

- **Sessions are removed.** `nuka session list` and `nuka session clear`
  are refused with `removed-command`, and `nuka do --session` with
  `removed-flag`. Each `nuka do`
  call starts clean, as each scenario already did.
  - A step that needs login state gets it from a fixture. A project that
    keeps a Playwright storageState file names it in
    `browserContext.storageState` or `requestContext.storageState`, which
    the config now passes through to Playwright instead of refusing.
  - Run `nuka clean`, or delete `.nukadoko/cache/` by hand: nothing reads
    it, and `cache/sessions/` holds each session's browser storage state,
    cookies included, so a stale login stays on disk until it goes.
    `nuka clean` lists and removes it, and the `records/` directory an
    earlier release wrote, under `legacy` in its `--json` plan, beside
    `records` and `export`.
  - A step record's `schema_version` is 3, and the record has no
    `session` field. A reader that checks `schema_version === 2` checks 3.

- **`nuka experimental explore` and its model API are removed.** The
  command (and the older `nuka explore` spelling) is refused with
  `removed-command`. `experimental_defineModel`,
  `experimental_defineRelation`, `experimental_modelCommand`, and
  `experimental_relationEntry` are no longer exported from `nukadoko`, so
  a file that imports them fails to load. Write each sequence worth
  keeping as a scenario, then delete the model and relation files. The
  `explore-*` finding codes are gone.

- **`nukadoko/mcp` is removed**, with the optional peer dependency on
  `@modelcontextprotocol/client`. A fixture that called `connectMcpServer`
  or `callMcpTool` uses the SDK's own client: add
  `@modelcontextprotocol/client` to the project, build a `Client` with a
  `StdioClientTransport` (from `@modelcontextprotocol/client/stdio`) in
  the fixture's setup, and close it in its teardown.

- **Each run is one directory, `.nukadoko/runs/<run_id>/`, and
  `records/` is no longer written.** A script, a CI step, or a tool that
  reads the state directory changes these paths:
  - `.nukadoko/records/runs/<run_id>/run.json`, `summary.md`, and
    `exports` are `.nukadoko/runs/<run_id>/run.json`, `summary.md`, and
    `exports`.
  - `.nukadoko/records/steps/<id>/` is
    `.nukadoko/runs/<run_id>/steps/<id>/` for a step `nuka run` ran, and
    `.nukadoko/do/<id>/` for a `nuka do` call.
  - `.nukadoko/records/scenarios/<id>/` is
    `.nukadoko/runs/<run_id>/scenarios/<id>/`.
  - Every path inside `run.json` (a step's `record`, a `used` entry's
    `record`, a scenario's `evidence.dir`) is relative to the run
    directory: `steps/<id>`, not `.nukadoko/records/steps/<id>`. Join it
    with the directory that holds `run.json`. The run summary's `record`
    cell is the same path. A step record's own `evidence.dir` is still
    relative to the project root.
  - A CI step that uploaded `.nukadoko/records/` uploads
    `.nukadoko/runs/` (docs/ci.md has a pinned `actions/upload-artifact`
    step; `.nukadoko` is a hidden directory, so it sets
    `include-hidden-files: true`).
  - A script that matched the retention line's age clause matches
    `unfinished runs and nuka do records older than`.
  A `.nukadoko/records/` directory an earlier release left is not read,
  and neither retention nor `nuka clean` removes it: delete it by hand
  (`rm -rf .nukadoko/records`). `nuka do --use` with an id from
  that directory is refused as not found; run the producing step again.
  The export output does not move.

- **`run.json` holds the whole run, and scenario record files are gone.**
  A script that read `run.json` or `nuka run --json` changes these reads:
  - `schema_version` is 2, the envelope's, and the document starts with
    `command: "run"`, `verdict`, and `findings`, which now holds every
    warning the run raised as well as each failed scenario.
  - A scenario's `rerun` is its `do`, present only on a failed scenario.
    Its `record` (the path of a scenario record file) is gone; read its
    `steps` instead: each step has `line`, `text`, `step`, `status`,
    `step_record_id`, `record` (the step record's directory), and for a
    failure `error.kind`, `error.message`, and `used`.
  - The top-level `summary` path is gone. The summary is
    `summary.md` in the same directory as `run.json`.
  - `commit` (`sha`, `dirty`), `target_version`, and `selection` are new.
    A script that tested a scenario record's `git.clean` tests
    `!commit.dirty`.
  - A script that read `.nukadoko/records/scenarios/<id>/record.json`
    reads that scenario's entry in `run.json`; the file is no longer
    written, and a scenario that wrote no screenshot, hook trace, or
    attachment leaves no scenario evidence directory (see the run
    directory item above for where one now lives).
  - A script that matched the "Partial run" paragraph on stderr reads
    `selection` in `run.json`, `partial` or `full`, or the
    `- selection:` line of the run summary.
  - A `--records` line is now a scenario's `run.json` entry: it has no
    `run_id`, `environment`, `git`, `nukadoko`, or
    `schema_version`; read those from `run.json`.
  The run summary gains a `- selection:` line and a "Findings" section; a
  CI step that only posts it needs nothing.

- **Every command's `--json` is one envelope, and every finding has one
  grammar.** A script that reads `--json` reads
  `{ schema_version: 2, nukadoko, command, verdict, findings, ... }`:
  - `errors`, `warnings`, and `notes` are gone. Filter `findings` by
    `severity` (`error`, `warning`, `note`, `refused`, `failed`).
  - A refusal is no longer `{ error, do }`. It is a finding with severity
    `refused` and a code, and the exit is still 2. Switch on `code`, not on
    the message.
  - `nuka steps --json` keeps `steps` beside `findings`; its
    `import_failures` are `step-file-import-failed` or
    `playwright-missing` findings. `nuka describe` keeps its contract
    fields beside `findings`. `nuka tend --json` keeps `summary` and
    `fail_on_hits`. `nuka run --json` keeps the `run.json` fields.
    `nuka check --codes --json` and `nuka tend --codes --json` keep
    `codes`, and each entry is a finding: its meaning is `message`, not
    `description`, and its general edit is `fix`, not `do`.
  - `verdict` is `passed`, `failed`, or `refused`, for exit 0, 1, and 2.
- **A finding's text is `<severity>\t<code>\t<where>\t<message>`, then
  `  fix:` and `  do:` lines.** A parser of `nuka check` text reads the
  severity in the first column. `  do:` is now only a command a shell runs
  as written; a hint in words, such as "Escape the bare ( ) ...", is on a
  `  fix:` line. A script that ran every `do:` line as prose stops reading
  it as prose; a script that runs it can run it as it is.
- **A failed scenario is a `scenario-failed` finding.** The `failed` and
  `rerun` lines on stderr are gone. A script that grepped `rerun` reads
  the `  do: nuka run <feature>:<line>` line under each
  `failed\tscenario-failed\t` line, or each failed scenario's `do` in
  `run.json`.
- **Warnings are findings with codes.** The no-config line is
  `warning\tconfig-missing\t-\t...` on stderr, and under `--json` it is
  in `findings`, with stderr empty. The same holds for a failed fixture
  teardown (`fixture-teardown-failed`), an emitter failure
  (`emitter-failed`), a version probe that did not answer
  (`version-probe-failed`), and the other run warnings `nuka check
  --codes` lists. A script that matched `Warning:` on stderr matches the
  `warning` column and the code.
- **An `undefined-step` message no longer names the scaffold command.**
  The command is on the `  do:` line. Each line with an undefined step
  has its own finding now, also a second line with the same text, so a
  count of `undefined-step` findings is a count of lines.

- **`nuka run` writes scenario records to stdout only under `--records`.**
  A pipe, a file, a CI log, and an agent's shell no longer get one JSON
  record per line by default; stdout stays empty. A script that parsed
  that stream picks one of three: add `--records` to the `nuka run` it
  reads (each line is now a scenario's `run.json` entry, see the
  `run.json` item below), switch to `--json`, or read
  `.nukadoko/runs/<run_id>/run.json`, which the run writes either
  way. A CI step that only shows the log needs nothing. The run summary, the
  stderr lines, and `nuka do`'s stdout do not change.
- **`evidence.attach` and `evidence.path` refuse `trace.<name>.zip` and
  `final.<name>.png`.** A `pageAs(name)` context writes those files beside
  a step's own `trace.zip` and `final.png`, so the names are reserved for
  every valid context name, in any case, with
  `ReservedEvidenceNameError`. A step that attached a file under such a
  name renames it, for example `trace-aki.zip` or `aki-final.png`.
- **`nuka tend` reports every code, and `--all` is removed.** A plain
  `nuka tend` now reports `schema-field-undescribed` too, in text and in
  `--json`. `nuka tend --all` exits 2 and says so; drop the flag. A job
  that reads plain `--json` and acts on some codes only filters
  `findings` by `code`, or passes `--fail-on` for each code it acts on.
  `nuka tend --codes` prints each code as a finding (see the next item),
  with no `reportedByDefault` on an entry.
- **A step record's `observed` channels are `null` when the step never
  reached them.** `http_reads` and `http_writes` are both `null` for a step
  that called none of `ctx.request()`, `ctx.page()`, and `pageAs()` and
  had no request recorded, and `observed.processes` is `null`, not absent,
  for a step that never called `runCommand`. The step record's
  `schema_version` is 2. A script that sums the counts treats `null` as
  "not measured", not as `0`; a script that tested for a missing
  `processes` key tests for `null`. A step whose zero count should mean
  something calls the server through the `request` fixture instead of
  `fetch`.
- **`--json` prints one document and nothing around it.** A script that
  scraped `nuka run --json`'s stderr for the `run` path, the count line, or
  a `rerun` line reads them from the document instead: `counts` and each
  failed scenario's `do`. A script that split a `--json`
  refusal by lines parses stdout as one JSON value; it is pretty-printed
  now. A test that compared `nuka steps` text at a terminal width other
  than 80 compares at 80.
- **`run.json` names every environment of the run, and holds one verdict
  per scenario and environment.** What changes for a reader of a run:
  - A script that read `run.json`'s `environment` reads
    `environments[0].name`, and `target_version` is
    `environments[0].target_version`. A run without `--env` has one entry,
    `default`.
  - A script that judged a scenario by its entries in `scenarios` reads
    `verdicts`, one cell per scenario and environment with `verdict`,
    `executions`, and `passed`. Each `scenarios` entry also names its
    `environment`.
  - A script that parsed the run summary's table reads the column named
    after the environment (`default` without `--env`) where it read
    `status`, and one row per scenario where `--repeat` gave one row per
    execution.
  - A CI job that ran `nuka run --env` once per environment can run
    `nuka run --env a --env b` as one step, with one summary.
  - An Allure history keyed on the old history ids starts over once: the
    environment is now part of a result's identity.

- **`nuka run` writes no Allure results or messages stream; `nuka report`
  renders them after the run.** The `allure` and `messages` config keys
  are refused with `config-key-removed`, and `nuka run --summary` with
  `removed-flag`.
  - Delete the `allure` and `messages` keys from the config.
  - Where a script or CI step read `.nukadoko/export/allure-results/`
    after `nuka run`, run `nuka report --format allure` after the run
    first. Where `allure.resultsDir` moved it, pass that directory as
    `--out`.
  - Where it read `messages.ndjson`, run `nuka report --format messages
    --out <path>`; where it read `messages.<run_id>.ndjson`, render that run
    with `nuka report .nukadoko/runs/<run_id> --format messages --out
    <path>`.
  - Where `nuka run --summary <path>` wrote a pull request comment, run
    `nuka report --format markdown --out <path>` in a step after the run,
    with `if: always()` so a red run is posted too.
  - A run from an earlier release has no `sources.json`, so its Allure or
    messages render is refused with `run-sources-missing`: run the
    scenarios again to render them.
  - An Allure history carries on: the result identity is unchanged. The
    `host` and `thread` labels are gone, and `allure watch` shows a run
    when it is rendered, not while it runs.
  - A JUnit or HTML report built from a messages stream of a run over
    several environments shows each scenario once per environment, named
    `<scenario> (<environment>)`.
  - A script that matched the `emitter-failed` or
    `export-path-outside-project` code matches `report-incomplete`; the
    second has no successor, since `nuka clean` no longer reads paths from
    the config. `emitter-failed` was a warning, and `report-incomplete`
    makes `nuka report` exit 1: a CI step that renders a run whose
    directory lost a file fails, so upload the whole run directory.
  - `nuka clean` removes under `.nukadoko/export/` only the files a run's
    exports manifest names and the contents of `allure-results/`. A file
    nukadoko did not write there, such as an `allure generate` report,
    stays; delete it yourself if a clean used to.

- **An env file that cannot be read is refused with
  `env-file-unreadable`, exit 2, under `nuka run --no-check` too.** It was
  `unexpected-error` under every command, and an `error` finding with exit
  1 under `--no-check`. A script that matched `unexpected-error` for an
  unreadable env file, or read exit 1 there as a failed run, matches
  `env-file-unreadable` and exit 2: nothing ran.

## 0.16.1 to 0.17.0

- **`nuka run` writes no scenario record to stdout when stdout is a
  terminal.** A pipe, a file, a CI log, and a shell an agent drives through
  a pipe still get one JSON record per line, unchanged. A tool that runs
  `nuka run` under a pseudo-terminal and parses its stdout passes
  `--records`, which writes them to a terminal too. The records on disk,
  the stderr lines, and `nuka do`'s stdout do not change.
- **Node 22.18.0 or later on the 22 line, or 23.6.0 or later.**
  `engines.node` is `^22.18.0 || >=23.6.0`. These are the first releases
  in which Node strips TypeScript types with no flag, and nukadoko now
  loads the config, the step files, and everything they import through
  Node itself. It no longer depends on tsx. A CI job pinned to Node 20 or
  to an earlier 22 moves to a supported version: `docs/ci.md` uses 24.
  Node 23.6 to 23.x prints an `ExperimentalWarning` the first time it
  loads a `.ts` file; 22.18 and 24 and later do not.
- **Only TypeScript that erasing its types leaves intact loads.** An
  `enum`, a `namespace` with values in it, and a constructor parameter
  property have run-time behavior, so Node refuses the file. This holds
  for a project file a step file imports too. `nuka check` reports
  `step-file-import-failed` with the file, the line, and what to write
  instead: an enum becomes an object with `as const`, and a parameter
  property becomes a field assigned in the constructor. Set
  `"erasableSyntaxOnly": true` (TypeScript 5.8 and later) in
  `tsconfig.json`, and `tsc` reports each one before nuka does. On Node
  23.x, Node's report names no file. The finding still names the line
  when the step file itself holds the syntax; when an imported module
  holds it, the finding has no line and says so.
- **A type imported without `type` fails to load.** Node cannot tell that
  `import { Options } from "./options.ts"` names only a type, so the import
  fails with "does not provide an export named 'Options'". Write
  `import type { Options }` or `import { type Options }`. With
  `"verbatimModuleSyntax": true`, `tsc` requires that spelling. For a
  type that nukadoko exports, such as `IWorldOptions` from
  `nukadoko/compat`, `nuka check`'s finding says to write `import type`.
- **`nuka scaffold` imports a `--from` producer by its `.ts` name when
  `tsc` accepts one.** A step scaffolded with `--from run-greet.<key>`
  imports `./run-greet.ts` when `tsconfig.json`, or a file it extends,
  sets `rewriteRelativeImportExtensions` or `allowImportingTsExtensions`
  to true, and when the project has no `tsconfig.json`. Otherwise it
  imports `./run-greet.js` and prints a `note:` line on stderr that names
  the option. A step file that already imports by the `.js` name keeps
  loading under nuka, which falls back to the `.ts` file when no `.js` file
  exists, so renaming is optional. A plain `node` run of that file does not
  fall back. For `tsc` to accept a `.ts` name, `tsconfig.json` needs
  `"rewriteRelativeImportExtensions": true` (TypeScript 5.7 and later) or
  `"allowImportingTsExtensions": true` (which `tsc` accepts only with
  `noEmit`). `nuka init` now adds the first one to a `tsconfig.json` that
  has `compilerOptions` of its own and names neither option, unless a
  file it `extends` names one. A `tsconfig.json` whose options come only
  through `extends` gets a line on stderr instead. A project initialized
  before this release adds it by hand.
- **`paths` and `baseUrl` in `tsconfig.json` no longer resolve at run
  time.** tsx read them; Node does not. A step file that imports
  `@app/server` through `paths` fails to import. Use a relative path, or a
  `#app/*` entry in `package.json`'s `imports`, which Node and `tsc` both
  read.
- **A `package.json` with no `"type"` now loads a `.ts` file written as an
  ES module.** Node reparses it, and prints a `MODULE_TYPELESS_PACKAGE_JSON`
  warning for each such file. `nuka init` still writes
  `nukadoko.config.mts` there, and `.mts` step files load with no warning.
  Add `"type": "module"` to `package.json` to keep `.ts` names with no
  warning. `nuka tend` reports this as `package-type-missing`. With `"type": "commonjs"`, a `.ts` file still fails to import,
  and the error says to rename it to `.mts`.
- **`undefined-step`'s message names `nuka scaffold --feature <file>`.**
  It used to end with "run `nuka scaffold <name>` to add one"; it now
  names the feature file the line is in, so the command writes a stub for
  every undefined line of that file. The code and its `file` and `line`
  are unchanged. Under `nuka run --no-check`, an undefined step's
  `error.message` in the scenario record changes the same way. A script
  that matches the old sentence matches on the code instead, or on the
  step's `status: "undefined"` in a scenario record.
- **A step record that passed says `"status": "passed"`, not `"ok"`.** The
  same word now means success in a step record, in a scenario record's
  `steps[]` and `hooks[]`, and in `nuka experimental explore --json`'s
  `steps[]`. A
  script or a jq filter that tests `.status == "ok"` tests `"passed"`. A
  record that nukadoko 0.16.1 or earlier wrote still says `"ok"` on disk; `nuka do
  --use` and the emitters read it as `"passed"`, so it can
  stay until retention removes it. The exported TypeScript type
  `StepRecordOk` is now `StepRecordPassed`.
- **`nuka run`'s step lines on stderr say `passed`, `failed`, and
  `skipped`, not `ok`, `FAIL`, and `skip`.** They now use the word the
  step record uses for the same outcome. A script that searches a CI log
  for `  FAIL  ` searches for `  failed  `.
- **`nuka tend --json` names its summary keys in snake_case.**
  `typedSteps`, `compatSteps`, `compatStepNames`, `scannedFeatureDirs`, and
  `readOnlySteps` become `typed_steps`, `compat_steps`,
  `compat_step_names`, `scanned_feature_dirs`, and `read_only_steps`.
  `describe` keeps its name.
- **`nuka describe` shows `from` in the shape `nuka steps --json` uses.**
  A key with one producer is `{ "step": "create-project", "key": "id" }`
  instead of the string `"create-project.id"`, and a key with several is
  an array of those objects instead of `"either of A or B"`.
- **`nuka run --session` is gone.** It exits 2 and writes nothing. A
  scenario that needs login state gets it from a fixture or a Given step
  its feature names, so each scenario starts clean whatever ran before it
  and at any `--concurrency`. A fixture that signs in with `scope: "process"`
  logs in once per process, not once per scenario. `nuka do
  --session <name>` is unchanged.
- **`nuka init` takes `--allure` only.** `--base-url`, `--features-dir`,
  and `--env` exit 2, name what replaces them, and write nothing. Set
  `baseURL` in the generated config after `init`. For a features
  directory other than `features/`, set `featuresDir` in the config and
  move `features/steps/` there. `init` now always adds `.env`, `.env.*`,
  and `!.env.example` to `.gitignore`; delete those lines if the project
  commits a `.env` on purpose. (`--env` was briefly spelled
  `--env-files` before this release; that spelling is refused the same
  way.)
- **`nuka clean` takes `--dry-run` and `--json` only.** `--records`,
  `--cache`, and `--export` exit 2 and remove nothing. `nuka clean`
  always removes records, cache, and export together. To keep one of
  them, copy it out of `.nukadoko/` first, or let retention remove old
  runs on its own at the end of every `nuka run`.
- **`nuka check --codes --json` and `nuka session list --json` print an
  object, not a bare array.** Every JSON document now starts with
  `schema_version`, and an array has no place for it. The list moved under
  one key: `{ "schema_version": 1, "codes": [...] }` and
  `{ "schema_version": 1, "sessions": [...] }`. A jq filter `.[]` becomes
  `.codes[]` or `.sessions[]`. Every other document only gained the
  `schema_version` key in front, and the step and scenario records also
  gained `nukadoko`.
- **`records/runs/<run_id>/complete.json` is now `run.json`.** The run's
  completion marker grew into its whole result: `verdict`, `finished_at`,
  and `counts.failed` hold what `complete.json` held as `verdict`,
  `finished_at`, and `failed_scenarios`, beside the run id, every scenario
  with its record and rerun command, and the summary path. A script that
  read `complete.json` reads `run.json`, or runs `nuka run --json` and
  reads stdout. Runs written by 0.16.1 or earlier have only `complete.json`, which
  retention no longer reads as proof that they ended, so it keeps them
  until they are older than `retention.adHocDays`; `nuka clean` removes
  them now (it also removes the cache and the export, so copy out what you
  keep first).
- **`nuka scaffold` refuses to write below a directory that holds the
  config.** Run where neither `nukadoko.config.ts` nor
  `nukadoko.config.mts` exists, while a parent directory up to the nearest
  `.git` has one, it exits 2 with `Refusing to scaffold:` and the relative
  path to that config, where it used to write a step file the config never
  read. Run `nuka scaffold` from the directory that holds the config; in a
  workspace that is the package. A script that scaffolded from a
  subdirectory moves its `cd`. Every other command keeps its exit code and
  stdout, and adds one stderr line that names the missing config.
- **A project on a later Playwright 1.x keeps it.** The `playwright` peer
  range is `^1.61.1` now, not the exact `1.61.1`, so npm installs nukadoko
  beside any later 1.x without `ERESOLVE`. A project that pinned its own
  `playwright` to 1.61.1 only for nukadoko can move it forward. nukadoko is
  still tested against 1.61.1, and the `playwright-missing` install line
  still names that version.
- **`defineStep` no longer takes `rationale`.** Delete the `rationale:`
  lines from your step files. Until you do, `nuka check` warns
  `step-option-ignored` once for each, naming the step file, and `tsc`
  reports each one as an excess property where `tsconfig.json` includes
  the step files. `nuka` ignores the value at run time, so runs do
  not change. A reason worth keeping can move into a comment above
  `defineStep`. `nuka describe` prints no `rationale` key, and `nuka
  tend --json` has no `summary.rationale`.
- **A step with no `returns` fails when `run` returns an object with
  keys.** The value used to be dropped and the step record held `{}`
  while the step passed. Now the step fails with `result_invalid`, and
  the message names the keys. Declare `returns` with those keys if the
  value is worth keeping in the record, or stop returning it. `tsc`
  already rejected such a return where `tsconfig.json` includes the step
  files, so a project that typechecks them sees no change.
- **`nuka tend` no longer reports `step-rationale-missing`,
  `additional-feature-dir-missing`, or `import-failures-unseen`.** The
  first went with `rationale`. The other two said what `nuka check` already
  reports, as `additional-feature-dir-missing` (an error) and
  `step-file-import-failed`, so gate on `nuka check`'s exit code instead.
  `nuka tend --fail-on` with any of the three exits 2 and says what to do
  instead, so a CI job that names one fails until it is edited. The
  `declared:` line reads `declared: describe <n>/<total>`; a script that
  reads the `rationale` count reads the `describe` count instead.
- **`nuka harvest` is removed.** It exits 2 and names this note. Write
  the scenario from the `nuka do` calls you ran: one line per step in the
  order they ran, worded to match its pattern, with `Given`, `When`, or
  `Then` chosen by what the line tells a reader. Leave a value an earlier
  step produced off the line, since the step's `from` supplies it. Then
  run `nuka check`, which reads every line back against the vocabulary.
  The acceptance skill's "Where to start" route for an exploration says
  the same.
- **Live sessions are removed: `nuka session start`, `nuka session stop`,
  and `--idle-timeout`.** `nuka session start` and `nuka session stop`
  exit 2 and name this note. `nuka do <step> --session <name>` still
  carries login state across calls as a saved storageState file, and
  `nuka session list` and `nuka session clear` still list and delete
  those files. What a live session was for, exploring a browser app whose
  state cannot be repeated, now goes through the agent host's Playwright
  MCP server: a Claude Code host adds it with
  `claude mcp add playwright npx @playwright/mcp@latest`, and the
  acceptance skill says how to tell whether it is connected and how to
  turn what it found into a scenario. Its `--isolated
  --storage-state=<file>` options start it from a session that
  `nuka do --session` saved. With live sessions gone, a step record no
  longer carries `session_execution`, `nuka do --session` no longer
  prints a line saying the session is not live, and `nuka run` no longer
  reports a live session or skips retention for one. `nuka clean` no
  longer refuses while a session lock is held. A script that started a
  session, drove it with `nuka do --session`, and stopped it gets the
  same login state from `nuka do --session` alone; state beyond login
  does not carry across calls.
- **`recordStep` is no longer exported, and neither are
  `RecordStepOptions`, `StepExecution`, or
  `UnsupportedExternalFixtureError`.** A Playwright Test spec that imports
  `recordStep` fails to compile. Call the shared function the step's `run`
  calls directly from the spec, and delete the `nukadoko` import: the spec
  then depends only on Playwright again (docs/migration-playwright-test.md,
  "Share the implementation, not the runner"). Records `recordStep` wrote
  stay on disk with `kind: "external"` until retention removes them.
- **The text output of `nuka check` and `nuka tend` prints a `do:` line
  under each finding, and names the step file of a step finding.** The
  line starts with two spaces (`  do: nuka scaffold --feature
  features/greet.feature`). For a finding about one step, the third column
  now holds the step file, not the step name; the message still names the
  step. `--codes` text has a fourth column, the code's general `do`. A
  script that reads text output skips the lines that start with two
  spaces, or reads `--json`, where `file` and `do` are fields and nothing
  else changed.
- **`nuka explore` is now `nuka experimental explore`.** Same flags, same
  output. `nuka explore` exits 2 and names the new spelling, so a script
  that ran `nuka explore features/explore/add-model.ts` becomes
  `nuka experimental explore features/explore/add-model.ts`. A model or a
  relation file imports the renamed functions: `defineModel` is
  `experimental_defineModel`, `modelCommand` is
  `experimental_modelCommand`, `defineRelation` is
  `experimental_defineRelation`, and `relationEntry` is
  `experimental_relationEntry`. The type names do not change. Under
  `experimental`, the command and the functions can change shape or go in
  a later release without a deprecation notice.
- **`nuka experimental webmcp-tools`, `experimental_callWebmcpTool`, and
  `nuka experimental mcp-tools` are removed.** Each was experimental. To
  list an MCP server's tools, use the agent's own MCP host or an MCP
  client such as the MCP Inspector. A step that called
  `experimental_callWebmcpTool` calls the page's tool itself through
  `page.evaluate`. `connectMcpServer` and `callMcpTool` from
  `nukadoko/mcp` are unchanged.
- **A `--json` command that refuses writes `{ "schema_version", "error",
  "do" }` on stdout.** It used to write prose on stderr and nothing on stdout. A
  script that reads stdout only after a zero exit is unaffected. One that
  reads stderr for the reason reads `error` from the JSON line instead,
  and `do` names the command to run next. `nuka describe` always answers
  this way, with or without `--json`. A refusal without `--json` keeps
  its stderr message and adds a last line, `do: <command>`.
- **A command that refused exits 2, not 1.** Exit 1 used to mean both
  "the suite is red" and "nothing ran". It now means only the first: a
  `nuka check` error, a failed scenario, a failed `nuka do` step, a
  `nuka tend --fail-on` hit. A refusal (an unknown flag, an invalid
  config, a missing target, an unknown step, a missing peer dependency,
  and `nuka run` stopped by the errors `nuka check` reports) exits 2. A
  script or CI step that tests `!= 0` keeps working. One that tests
  `== 1` to mean "red" now misses a refusal: test `!= 0` for "not green",
  or `== 2` for "fix the invocation". The table is in docs/spec.md
  "Streams and exit codes".

## 0.15.0 to 0.16.1

- **`nuka tend` leaves out `step-rationale-missing` and
  `schema-field-undescribed` unless asked.** A missing `rationale` or
  `.describe()` is a gap a project may keep, and reporting both on every
  run buried the findings about real rot. `nuka tend --all` reports them
  again, in text and in `--json`. A job that runs `nuka tend --fail-on
  step-rationale-missing` (or `schema-field-undescribed`) keeps working
  unchanged, since naming a code in `--fail-on` reports it. A job or
  script that reads either code from plain `nuka tend --json` adds
  `--all`. A placeholder `rationale: ""` written only to quiet the note
  can go.
- **`nuka tend` reports `step-description-todo` by default.** A typed step
  whose description still begins with `TODO: describe`, the placeholder
  `nuka scaffold` writes without `--description`, gets one note naming
  its file. The exit code does not change unless `--fail-on` names the
  code. A job or script that treats any note from plain `nuka tend` as a
  failure, or waits for `ok: nothing to tend`, sees one note per such
  step: write what each step does in its `description`.
- **`nuka mcp-tools` is now `nuka experimental mcp-tools`.** Same flags,
  same output. The old spelling exits 1 and names the new one, so a
  script that ran `nuka mcp-tools -- <command>` becomes
  `nuka experimental mcp-tools -- <command>`. Under `experimental`, its
  shape may change in a later release without a deprecation notice. 0.17.0
  removes both spellings; see "0.16.1 to 0.17.0".

`nuka run` now refuses what `nuka check` refuses, which a project that runs a feature `check` reports an error for has to act on.

**`nuka run` performs the static check first.** Before it executes
anything, `nuka run` reports what `nuka check` reports for the scenarios it
selected. When one finding is an error, it prints the errors on stderr,
writes no record, and exits 1. What to do:

- **A script that chains `nuka check && nuka run features` keeps
  working.** It checks twice, which costs one more step discovery. It can
  shrink to `nuka run`: with no target, `nuka run` now runs `featuresDir`
  (it used to exit 1 asking for a target). Keep the separate `nuka check`
  where `additionalFeatureDirs` holds features, since `nuka run` with no
  target does not walk them.
- **A feature `nuka check` rejects no longer runs.** Fix the finding, or
  pass `--no-check` for a deliberate run of it, for example while a
  migrating suite still has an `undefined-step`. A run-scope error, such
  as a `duplicate-pattern` or a step file that fails to import, now stops
  every `nuka run` in the project, not only the scenarios that reach it.
- **A script that matched a run-time failure for one of these now sees
  the refusal.** An undefined step used to fail its scenario with a record;
  now no scenario runs, and stderr carries the `nuka check` line instead.

`playwright` is no longer installed with nukadoko, which a project with a browser or HTTP step has to act on.

**Playwright is an optional peer dependency.** It and `playwright-core`
were most of the install, and a project whose steps never use `page`,
`context`, or `request` never needed them. nukadoko now declares
`playwright` as an optional peer dependency and loads it only when one of
those fixtures is first built. What to do:

- **A project with a step or fixture that uses `page`, `context`, or
  `request` adds `playwright` to its own `devDependencies`,** at the exact
  version nukadoko is tested against:
  `npm install -D -E playwright@1.61.1`. Without it, `nuka check` reports
  `playwright-missing` with one line that names the step and this command,
  and `nuka run` stops before any step runs, as it does for any `nuka check`
  error. `nuka run --no-check` runs anyway, and the first such step fails
  with the same line. `nuka experimental webmcp-tools` needs it the same way.
- **CI changes only by that one line in `package.json`.** `npm ci` installs
  `playwright` once it is a devDependency of the project, and
  `npx playwright install --with-deps chromium` keeps downloading the
  browser in the job that runs browser steps, as [docs/ci.md](ci.md) shows.
  A job that runs only `nuka check`, or a project with no browser step, can
  drop any browser install line.
- **A project without a browser or HTTP step typechecks without
  `playwright`, with any `skipLibCheck`.** nukadoko's own type
  declarations name Playwright's `Page` and `APIRequestContext` for the
  `page` and `request` fixtures. When `playwright` is missing, those types
  are `any` and `tsc` passes. When it is installed, they are Playwright's
  own types.
- **A project whose own `playwright` is at another version pins it to
  1.61.1.** npm refuses (`ERESOLVE`) to install nukadoko beside a
  different `playwright`, where it used to install a second copy.

## 0.14.1 to 0.15.0

`nuka accept` and every sign-off finding are removed, which a project that signs off features, or gates CI on a sign-off, has to act on.
Compat behaviour a project can notice, one redaction change, and one evidence-name change.
`nuka session clear --env` and `nuka session stop` also name a typo that used to exit 0 with no output.
The Allure and messages emitters are off by default now, which a project that reads either export has to act on.

**`nuka accept` is gone, and the run summary replaces it.** No project kept
the records it wrote, and the run summary carries the same claim ("green
at this commit") as evidence bound to its commit; the approval itself is
recorded wherever the team records approvals. Every `nuka run` now writes that summary; [docs/ci.md](ci.md) shows
how to post it on the pull request. What to do:

- **Remove `nuka accept` from scripts and CI.** The command no longer
  exists, so `nuka accept <feature>` exits 1 with yargs' unknown-argument
  error (exit 2 from the release after 0.16.1 on, where every refusal
  exits 2). Where a job ran it after a green `nuka run`, post the run summary
  instead: `nuka run <features> --summary <path>`, then a step that comments
  that file on the pull request (the workflow in [docs/ci.md](ci.md) has
  one).
- **Replace a PR check that a feature has a sign-off record.** A job that
  looked for a `<feature>.*.md` file beside each changed feature, or ran
  `nuka tend --fail-on feature-never-signed`, has nothing left to check.
  The reviewer now reads the `.feature` in the diff and the run summary on
  the pull request; the run is the evidence, and where the approval is
  recorded is the team's process (see "Review" in
  [docs/spec.md](spec.md#review)). `nuka
  tend --fail-on` with any of the removed codes (`feature-never-signed`,
  `signed-feature-unscanned`, `signoff-condition-mismatch`,
  `signoff-feature-changed`, `signoff-feature-missing`,
  `signoff-record-old-format`, `signoff-record-unreadable`,
  `signoff-result-invalid`, `signoff-step-missing`) exits 1 (2 from the
  release after 0.16.1 on) before analyzing anything, and stderr names the code and says the run summary
  replaced it. Drop the flag, or gate on a code `nuka tend` still reports.
- **Old `*.feature.*.md` records are inert.** Nothing reads them any more:
  `nuka tend` says nothing about them, and they are not scenarios unless
  `oaths` names them. Delete them, or keep them as history; either is
  safe.
- **`nuka tend` exits 0 unless `--fail-on` fires.** Its one error used to
  be a stale sign-off. Every finding is now a note, and `--json` keeps
  `errors` as an empty array, so a reader of that field needs no change.
- **A `:line` run's stderr notice changed.** It used to say a partial run
  could not be accepted. It now says the run summary covers only the
  selected scenarios. A script matching the old sentence has to match the
  new one.

The env file parser now follows dotenv for comments, quotes, escapes, and
values that span lines. A project whose env files relied on the old reading
has to look at those values before the next run.

- **`nuka tend --json` names a fixture in `fixture`, not `step`.** The
  `fixture-unused` and `fixture-touches-app` notes used to carry the fixture
  name in `step`. They now carry it in a new `fixture` field and leave `step`
  unset. A script that selected these notes by `.step` should select by
  `.fixture`. Text output is unchanged.
- **`this.link`'s second argument is another URL, not a display name.**
  `this.link(a, b)` used to record one link whose name was `b`. It now
  records one declared link per argument, and none of them has a name,
  which is what cucumber-js does with a URL list. A call that passed a
  display name should drop that argument. An allure `link(url, name)` call
  is unchanged: that name still lands on the declared link.
- **`this.attach` now follows the cucumber-js payload forms.** A `base64:`
  media type is decoded before the file is written. `{ mediaType, fileName }`
  uses that file name. A readable stream is read, and the call returns a
  promise the step must await. A project that read the old base64 text, or
  the JSON of a stream object, out of the attachment file will now read the
  decoded bytes or the stream's contents.
- **`defineWorld` refuses `page` and `request`.** Those names are harness
  getters. A declaration of either used to pass `nuka check` and then crash
  `nuka run` with `WorldNotOpenedError`. Remove the key from `defineWorld`.
  A subclass can still assign `this.page` and `this.request`.
  `await this.openPage()` and `await this.openRequest()` are unchanged.
  `nuka check` reports a leftover declaration as `step-file-import-failed`,
  and `nuka run` stops with the same message, which names the field.
- **Encoded forms of a loaded secret disappear from records, and two keys can newly collide.**
  The percent-encoded form and the JSON-escaped form are replaced with
  `{{secret.NAME}}`, same as the raw value. A script that searched a
  record for the encoded secret was reading a leak. It now finds the
  token. Two object keys that are the raw value and one of those forms
  redact to one string, and `redact` throws and names both keys instead
  of dropping one. A JSON number equal to a numeric secret is unchanged.
  Nothing in config has to move.
- **`ctx.evidence.attach` and `ctx.evidence.path` refuse a harness file name.**
  `record.json`, `final.png`, `trace.zip`, and `http.jsonl` now throw
  `ReservedEvidenceNameError`, including a spelling that differs only by
  case. A step that attached one of those and read that path back has to
  pick a different name. Two other names that differ only by case are kept
  as two files, the same way two identical names already were: the second
  gets `-2` before the extension (`Report.txt`, then `report-2.txt`). On a
  case-sensitive volume those two names used to be two files. On a
  case-insensitive volume they used to be one file, and the first body was
  lost.
- **A `#` in an unquoted value is a comment.** `TOKEN=abc123 # rotated` used
  to load `abc123 # rotated`. It now loads `abc123`. The `#` needs no space
  in front of it. To keep a `#` in the value, put the value in quotes.
- **Double quotes expand `\n` and `\r`.** `KEY="line1\nline2"` used to load
  the two characters `\` and `n`. It now loads a newline. Single quotes and
  backticks do not expand escapes, so use those when the backslash must stay.
  A backslash before `\n` is not special: `\\n` in double quotes is a
  backslash followed by a newline.
- **A quoted value may span lines, and backticks are quotes.** A private key
  written across lines used to be split, and a line inside it could become
  its own key. The secret then sat in neither `ctx.env` nor the secret set.
  It is now one value. `` KEY=`backtick` `` used to keep the backtick
  characters. It now loads `backtick`.
- **`nuka check` warns with `env-file-skipped-line`.** The finding names the
  file and the line number, not the text. The run still loads every binding
  it could read, and the warning does not by itself fail `nuka check`. A
  line that was never a binding was already not loaded. The warning is how
  you see it. The separator is `=`. A line that uses `:` is this warning.
- **`nuka session clear --env <name>` refuses an environment the config
  does not define, when that environment has no session files left.** It
  used to exit 0 and print nothing, so a typo looked like the sessions
  were gone. The message is the same one `nuka do --env` already uses.
  Session files left under an environment removed from the config are
  still cleared, and the command still exits 0. stderr names that
  environment. Omitting `--env` is unchanged: it clears the implicit
  `default` environment, which does not have to be listed.
- **`nuka session stop <name>` of a name that was never a session still
  exits 0, and now writes one stderr line** naming the session and the
  environment. A script that treats any stderr as failure will see that
  line. Stopping a live session, or cleaning up a stale lock, is
  unchanged and still quiet on success.
- **`returns` is optional, and `nuka scaffold` takes `--pattern` and
  `--then`. Nothing a project already has changes meaning.** A step that
  declares `returns` still has to return the value it validates, and a
  one-parameter `run({ page })` still names a fixture. A step whose
  `returns` is `z.object({})` may drop that line and its `return {}`, and
  does not have to. An early `return {}` inside an `if` becomes `return;`,
  or the step falls through to the code after it.
- **The Allure and messages emitters are off until their config key is
  present.** `nuka run` used to write `.nukadoko/export/allure-results/`
  and `.nukadoko/export/messages.ndjson` with no configuration. A project
  that reads Allure results adds `allure: {}` to `nukadoko.config.ts`, and
  a project that feeds cucumber messages to a formatter or JUnit-based CI
  adds `messages: {}`. A project that already sets `allure.resultsDir` or
  `messages.output` changes nothing, since the key is already there. A
  project that reads neither can delete `allurerc.mjs` and the export
  directory; `nuka clean --export` still removes what earlier runs wrote.
  From the release after 0.16.1 on, `--export` exits 2 and plain
  `nuka clean` removes the export together with the records and the
  cache.
- **`nuka init` writes less and wires more.** It no longer writes
  `allurerc.mjs`, the results directory, or the `.env` lines in
  `.gitignore` unless `--allure` or `--env` asks for them, and it adds a
  `test:scenarios` script to `package.json`. This changes only what a new
  `init` writes; a project already initialized needs nothing.

**Optional after upgrading from 0.14.x or earlier.** Three things a
project often wrote by hand are built in since 0.15.0. `nuka check` and
`nuka run` accept the hand-written copies, so nothing fails until they go.
From the release after 0.16.1 on, `nuka tend` reports the first one as
`fixture-replaces-builtin`.

- **`scratch` is a builtin fixture.** A `scratch` entry in
  `config.fixtures` and its `StepFixtures` declaration can go when
  `scratch.dir(prefix)` and `scratch.copy(source)` cover what they did.
  Each returns a new temporary directory, which is removed when the
  scenario ends, pass or fail, and is listed in the step record's
  `evidence.scratch`. While the project's own entry exists, it replaces
  the builtin.
- **`runCommand` replaces a `spawnSync` wrapper, and an `execFileSync` or
  `execSync` call.** `import { runCommand } from "nukadoko"`, then
  `await runCommand(command, args, { cwd, env, input, timeout })`. Each
  call inside a step adds an entry to the step record's
  `observed.processes`. Two differences from `spawnSync` cost a
  run if they are missed. It returns a Promise, so each caller gains
  `await` and becomes `async`: a caller without `await` passes
  `nuka check` and fails at run time with `returns validation failed`
  (`tsc` reports it first). And `exitCode` is `number | null`, `null`
  when a signal ended the process, so a step whose `returns` declares
  `exitCode: z.number()` returns `exitCode ?? 1`, or declares
  `z.number().nullable()`. A failed run prints the `used <step> exit
  <code> <first stderr line>` line only when the step that ran the
  program returns both `exitCode` and `stderr`.
  A third difference applies to `execFileSync` and `execSync`, and
  missing it fails nothing: they throw on a nonzero exit, and `runCommand`
  resolves. A step that relied on that throw as its assertion passes when
  the program failed, and `nuka check` stays green. Where the step needs
  the program to succeed, check `exitCode` yourself:
  `if (exitCode !== 0) throw new Error(stderr)`. `runCommand` returns
  `{ exitCode, signal, stdout, stderr }`, not the stdout text, and it runs
  no shell, so an `execSync` string becomes a command and its arguments.
- **An empty `returns` can go.** A step whose `returns` is
  `z.object({})` may drop that line and its final `return {}`. An early
  `return {}` inside an `if` becomes `return;`: deleting it makes the step
  fall through to the code after it, such as the next assertion.

## 0.14.0 to 0.14.1

- **`nuka check` can newly report `outline-does-not-run`, an error.** A
  Scenario Outline with no Examples table, and an Examples table with a
  header and no body row, used to pass `check`. The first ran once with
  the placeholder text left in, and the second produced no scenario at
  all. Add an Examples row for each case that must run, or remove the
  empty Examples table. This is the only reason a `check` that was green
  on 0.14.0 turns red on 0.14.1.

## 0.12.0 to 0.13.0

Behaviour changes worth knowing before upgrading.

- **A typed step that runs longer than twenty minutes now fails.** It used
  to run forever, taking the run with it. The limit is `stepTimeout` in
  `nukadoko.config.ts`; one step raises its own with
  `defineStep({ timeout })`. If a step in this project legitimately takes
  longer, set the number before upgrading, since the failure looks like an
  ordinary step failure with `error.kind: "timeout"`. There is no value
  meaning "no limit". Compat steps are unaffected: they still run unbounded
  unless their own glue declares `{ timeout }` or calls `setDefaultTimeout`.
- **A `--concurrency <n>` run writes one extra line per scenario**, naming
  the worker and the scenario as it starts. A script parsing stderr for the
  existing `scenario <n>/<total>` line is unaffected; one matching every
  line starting with `scenario ` now sees both. `--quiet` suppresses both.
- **A config file with no default export, or a Promise as its default, now fails and names the file.**
  It used to be read as `{}`, so the keys in the file were ignored.
  Export the object: `export default defineConfig({ ... })`.
- **An env file that cannot be read, or a directory at that path, now
  stops setup.** It used to be skipped, and the first `requireEnv` blamed
  the key. The refusal names the configured path and the errno. A path
  that is not on disk still contributes nothing, and `nuka check` still
  warns about that absence. Fix the path or its permissions before
  upgrading if a run was depending on the skip.

## 0.11.0 to 0.12.0

Additions, one fix, and one name.

- **New acceptance records are named `<feature-filename>.<date>-<sha>...`,
  extension included.** Records already written keep their old name and
  keep working: nothing reads a record by its name. A script that globs
  `<basename>.*.md` matches both forms; one that globs `<basename>.20*.md`
  matches only the old one and needs `<basename>.feature.*.md` as well.
- **A step can take one key from `from` and another from a table or
  docstring on the same line.** A suite that had made the chained key
  optional to get past `table-docstring-key-mismatch` can make it required
  again, which restores the from-order check for that step.
- **`nuka run --repeat <n>`, `nuka tend --fail-on <code>`, and the Condition
  section's declared-vs-observed count** are additions; nothing already in
  place changes.

## 0.10.1 to 0.11.0

`nuka run` now removes old records on its own, and a trace file exists once
on disk instead of twice.

- **The first `nuka run` after upgrading removes every run older than the
  newest 20.** Runs are read from the scenario records already on disk,
  so a state directory that grew for weeks shrinks at the end of that first
  run, and the run prints one `retention:` line saying how many runs went.
  If that is not wanted, set `retention.runs` in `nukadoko.config.ts`
  before running; there is no "keep everything" value, only a larger
  number. `retention.adHocDays` (default 7) is the separate lifetime of a
  record no run owns, such as a `nuka do` record.
- **`nuka accept` and `nuka tend` see only the retained runs.** A feature
  whose last green run is older than the newest `retention.runs` runs now
  reads as never run; run it again before accepting it. Sign-off records
  already written are unaffected: they live beside the feature, not under
  `.nukadoko/`.
- **`nuka do --use <id>` and `nuka harvest <id>` can now refuse an id that
  used to resolve.** The refusal says the record may have aged out and
  names the policy in force, rather than only "no such step record".
- **`allure-results/` written by 0.10 and earlier is not pruned.**
  Retention removes an export file only through the manifest the run that
  wrote it left under `.nukadoko/records/runs/<run_id>/`, and older runs
  left none. Every run from now on removes its own files when it ages out,
  so what stays forever is only what was written before the upgrade.

  `nuka clean --export` empties the whole directory, which also drops the
  reports of the runs kept since the upgrade. (From the release after
  0.16.1 on, `--export` exits 2, and plain `nuka clean` also removes the
  records and the cache.) To keep those, delete only
  what predates the upgrade instead, which nothing tracks either way:

  ```sh
  find .nukadoko/export/allure-results -type f ! -newermt '<the day you upgraded>' -delete
  ```
- **A trace or screenshot under `allure-results/` is now a hard link to
  the file under `records/steps/<id>/`.** Nothing reads differently.
  Copying `.nukadoko/` with a tool that does not preserve links makes two
  files again, as before; `allure.resultsDir` on another filesystem falls
  back to a copy on its own.
- **`nuka clean --records` also removes `.nukadoko/records/runs/`.** A
  project that scripted a clean by path should include that directory.
  From the release after 0.16.1 on, `--records` exits 2, and plain
  `nuka clean` removes the records, the cache, and the export together.

## 0.10.0 to 0.10.1

One fix, with two things a project could notice.

- **A record's own object keys can now read differently.** `redact` used to
  walk object values and copy keys through untouched, so a secret spelled
  inside a key reached a step record verbatim. Keys go through the same
  replacements now. A script that reads a record by a key holding a secret
  was reading a leaked secret; it now reads `{{secret.NAME}}` in that
  position. Nothing else about a record moves, and the fixed-shape fields
  never carried a secret in a key to begin with.
- **`redact` can now throw where it silently dropped data before.** Two
  distinct keys can redact to one string, and the old code would have let
  the second overwrite the first and take a whole subtree with it. It
  throws and names both keys instead. The shape that reaches this is one
  key already spelling `{{secret.TOKEN}}` as ordinary data beside a sibling
  holding the raw value that token stands for. A run that hits it was
  losing data before this release without saying so.

## 0.9.0 to 0.10.0

`nuka run` writes more on stderr, and `nuka tend` reports one new note.
Why is in [CHANGELOG.md](../CHANGELOG.md) under `## 0.10.0`.

- **`nuka run` names each failed scenario on stderr, after the summary
  line.** One line per scenario that did not pass, carrying its feature
  path, line, and name, and `--quiet` keeps them the same way it keeps the
  summary. Anything parsing this command's stderr sees lines it has not
  seen before. stdout is unchanged: still one scenario record per line,
  and still the channel to parse.
- **`nuka tend` gains a `repeated-scenario-prefix` note.** It never
  changes the exit code, like every tend finding except sign-off
  staleness, so a periodic job that acts on tend's exit status is
  unaffected.

## 0.8.0 to 0.9.0

The acceptance record has one breaking change. `nuka tend`'s
`post-navigation-read` note also reads from a different place now. Why is
in [CHANGELOG.md](../CHANGELOG.md) under `## 0.9.0`.

- **A record `nuka accept` writes from now on drops `actions`,
  `page_events`, `sections`, `polls`, `declared`, `http_omitted`, and
  `truncated` from each step.** A script reading a newly accepted record
  needs to stop expecting these keys. Every one of them still lands on
  the step record under `.nukadoko/`; only the copy embedded in the
  committed record narrows. The committed record's own text names each
  key it dropped, so a reader is never left guessing.
- **A record already committed keeps working, unchanged.** Reading an
  existing acceptance record needs no change.
- **Each scenario in a record written from now on also carries a summary
  table**: step, status, ms, mutates, reads, writes.
- **`nuka tend`'s `post-navigation-read` note now reads step records under
  `.nukadoko/records/steps/`, not a committed one.** Nothing to do on the
  project side. To get the note back for a step, run the feature again.

## 0.7.0 to 0.8.0

The Allure report structure has one breaking change. One other behavior
change affects consumers of `nuka tend --json`.

- **Allure now writes one result for each scenario pickle.** Gherkin steps
  are entries inside that result. The Suites tab no longer groups results
  by `parentSuite` and `suite`, so a saved Suites view appears flat.
  Find Features in the Behaviors tab through the `feature` label, or use
  the result's `titlePath` hierarchy. A plain scenario keeps its existing
  history. Each Scenario Outline row starts a new history once because
  its Examples cells are now visible parameters. Live reports still
  update after each step, but temporary progress snapshots now provide
  those updates. During a live session, a running scenario's retries can
  show older unknown snapshots. Nukadoko removes them when the scenario
  ends, so they do not appear in a report generated after the run.
  A consumer that reads `allure-results` during a run must treat
  `*-progress-result.json` as a temporary file. These files do not exist
  after a completed run.

- **`nuka tend`'s `post-navigation-read` notes are grouped now.** One note
  used to be emitted per step record, so a Background step in a suite with
  two dozen scenarios produced two dozen notes that differed only by file
  name. Matches that share a step, its navigation call, and the call that
  followed it are one note now, carrying how many step records it happened
  in and the range the gaps fell in. A script that counted notes to count
  occurrences counts distinct shapes instead; the occurrence count is in
  the note's own text.

## 0.6.0 to 0.7.0

One breaking change, plus a behavior change that is not breaking but is
worth knowing about, since it changes what a script watching `nuka run`'s
output actually sees. The breaking one: why is in
[CHANGELOG.md](../CHANGELOG.md) under `## 0.7.0`.

- **An args key a step's schema does not declare is refused now, not
  silently dropped.** `nuka describe` already published each object
  schema's own `additionalProperties: false`; the runtime now enforces
  the same shape everywhere a step can be called: `nuka do`, `nuka do
  --session <live>`, `nuka run`, `recordStep`, and the `call`
  fixture a part is invoked through. A key `from` or `--use` fills is
  never flagged, since either can only ever name a key the step already
  declared. **A successful step record's own `args` also changed shape**:
  it is now the schema-validated value, not the raw one, so a key filled
  by the schema's own `.default(...)` shows up in it even where the
  caller never typed it. A script comparing a step record's `args`
  against what it sent needs to allow for that: an added default is not a
  sign anything went wrong. A failed record is unaffected, and neither is
  a part's own `CallEntry.args`, which stays raw on both outcomes either
  way.
- **Not breaking, but worth knowing: `nuka run` no longer writes straight
  into `messages.output` while a run is in progress.** Each invocation now
  writes its own file (the configured path's own name with the run id
  spliced in, `messages.<run_id>.ndjson` under the default path) beside
  the configured path, and only replaces the configured path, atomically,
  once the run finishes; the change closes a real bug where two `nuka run`
  invocations against the same path used to interleave into one broken
  file. A script
  that tailed `messages.ndjson` to watch a run live no longer sees
  anything until the run ends; watch Allure instead (`npx allure watch`)
  for that. A script that treated the file being truncated as "a run just
  started" needs a different signal, since the configured path is not
  touched until the run's own end now. `messages.output` still ends up
  holding the newest completed run's own stream either way, so nothing
  that only reads it once the run is done needs to change. One thing to
  add to housekeeping: each run's own file accumulates beside the
  configured path now, removed only by `nuka clean [--export]`, a new
  command this release also adds (see the command's own `--help`).

## 0.4.1 to 0.5.0

Additive, with one narrow exception. Why is in
[CHANGELOG.md](../CHANGELOG.md) under `## 0.5.0`.

- **`Step` now always carries `parts`, so a hand-written `Step` object
  literal no longer typechecks.** `Step` is an exported type and `parts`
  is required on it, the same way `from` already is, so every reader can
  iterate it without checking for `undefined` first. Nothing built by
  `defineStep` is affected, and neither is code that only annotates or
  passes a `Step` around; the one thing that breaks is constructing the
  object by hand, which a test double is the usual reason to do. Add
  `parts: []` to it, or better, build it with `defineStep`.
- **Nothing else needs doing.** A step record gained an optional `calls`
  field, `nuka steps --json` and `nuka describe` gained `parts`, and
  `needs`/`needs_browser` now account for a step's parts. No field was
  renamed or removed, so an existing acceptance record stays valid and a
  script reading either JSON keeps working.

## 0.3.0 to 0.4.0

One breaking change, plus one action that is not breaking. Each entry
says what to fix; why is in [CHANGELOG.md](../CHANGELOG.md) under
`## 0.4.0`.

- **A step record's and a scenario record's id-bearing field names
  changed again, following one rule now: `<grain>_record_id`, or `run_id`
  for a run.** A script reading either JSON needs the current names: a
  step record's `record_id` is `step_record_id`; the owning scenario
  record's id on a step record, formerly `scenario`, is
  `scenario_record_id`; a scenario record's own `scenario_id` is
  `scenario_record_id`; a scenario record's `steps[].record` is
  `steps[].step_record_id`. A scenario record's own `scenario` field (the
  pickle's name, never an id) and `run_id` did not change, and neither
  did the `step-`/`scn-`/`run-` id prefixes. An existing acceptance
  record may need re-creating: `nuka run` the feature again and `nuka
  accept` it. Run `nuka tend` before upgrading to find out whether yours
  does, rather than assuming: it names every acceptance record that is
  actually affected (`signoff-record-old-format`), and names none for a
  feature that already lives inside `featuresDir`, since that feature
  runs unattended and its sign-off is no longer what carries the
  guarantee. Two more spots
  followed the old, bare convention and now match the same rule: a step
  record's `used[]` entries carried the upstream id under `record`,
  formerly; a script reading it needs `used[].step_record_id` now. And
  the Allure emitter's step parameter that used to be named just
  `"record"` is `"step record id"` now, so a script parsing Allure
  output by parameter name needs the new label.
- **Not breaking: a step record now also carries `run_id: string |
  null`.** Nothing stops working without reading it. A script that wants
  to know which run a step record belongs to, without opening the
  scenario record beside it first, can read this field instead.

## 0.2.0 to 0.3.0

Five breaking changes, plus one action that is not breaking but is needed
to opt in to a new capability. Each entry says what to fix; why is in
[CHANGELOG.md](../CHANGELOG.md) under `## 0.3.0`.

- **A step record's JSON changed field names and id prefix.** A script
  reading a step record's or scenario record's JSON needs the current
  names: `receipt_id` is now `record_id`, an id starts `step-` rather
  than `rcpt-`, and a `used` entry's upstream key is `record`, not
  `receipt`.
- **`.nukadoko/` now splits into three directories, by purpose:
  `records/`, `export/`, and `cache/`.** A step record's own directory is
  now under `records/steps/<id>/`, a scenario record's under
  `records/scenarios/<id>/`; the Allure and messages emitters now write
  under `export/`; a session now lives under `cache/sessions/`.
  `.nukadoko/` is gitignored working state, so the old directories can
  simply be deleted; the next `nuka run` writes the new layout, nothing
  needs migrating out of them.
- **`--use` takes a `step-...` id now.** An id minted before this release
  points at a directory layout the tool no longer reads; re-run the
  producing step (`nuka do` or `nuka run`) to get one in the current
  shape.
- **An existing acceptance record may need re-creating.** Run `nuka
  tend` before upgrading and let it answer: it names every acceptance
  record actually affected (`signoff-record-old-format`), and names none
  for a feature inside `featuresDir`, whose sign-off it stopped
  reporting on in 0.3.0. For the ones it names, `nuka run` the feature
  again and `nuka accept` it.
- **`nuka tend` stops reporting a stale sign-off or a drifted condition
  for a feature that already lives inside `featuresDir`.** If a project
  relied on that finding for such a feature, the coverage moved: running
  that feature, already running unattended, is what confirms the same
  thing now. `signoff-record-unreadable` is unaffected. No code change is
  needed either way.
- **Not breaking, but needed to opt in: a project with its own
  `allurerc.mjs` needs `historyPath` added by hand to get Allure's
  history, trend, and flaky-across-runs views at scenario grain.** Nothing
  stops working without it, the same as before this release; the new
  scenario-level Allure test result just never shows up in those views.
  Add `historyPath: ".nukadoko/export/allure-history.jsonl"` (adjusted if
  `stateDir` in `nukadoko.config.ts` points elsewhere) alongside the
  existing `categories` array; `examples/allure/allurerc.mjs` shows the
  field in place. A project created with `nuka init` on this release
  already has it.

## 0.1.0 to 0.2.0

Three breaking changes. Each entry says what to fix; why is in
[CHANGELOG.md](../CHANGELOG.md) under `## 0.2.0`.

- **`nuka steps --json`'s top level changed from a bare array to `{ steps,
  import_failures }`.** Anything reading the old bare array needs to read
  `.steps` now; `import_failures` (`{ file, message }`) is new alongside
  it, always present, `[]` when nothing failed.
- **Allure now writes one test per step, not one test per scenario.** A
  report's test count is now a step count, not a scenario count. Read a
  scenario's own pass/fail from its `suite` row, not from a single test.
  Allure's history, trend, and flaky-across-runs views no longer work: if
  CI carried `history.jsonl` forward from a run's generated report into
  the next run's `allure-results/`, that carry-forward no longer does
  anything, since nothing in this emitter's output links a step to itself
  in an earlier run.
- **`nuka steps` now exits non-zero when the project has no features
  directory.** A script that ran it outside a nukadoko project, or after
  `featuresDir` was renamed without the config following, used to get an
  empty vocabulary and a clean exit. It now gets the resolved path it
  looked for on stderr and a non-zero exit, with nothing on stdout. If a
  pipeline was relying on the clean exit, point it at the right directory
  or fix `featuresDir` in `nukadoko.config.ts`. A project whose features
  directory exists but holds no steps is unaffected, and still exits `0`.

## 0.0.5 to 0.1.0

Three breaking changes. Each entry says what to fix; why is in
[CHANGELOG.md](../CHANGELOG.md) under `## 0.1.0`.

- **A typed step's `run` takes a fixture bag now, not `ctx`.** Collect
  every `ctx.foo` a step reads into a destructured first argument
  (`run({ page, section }, args)`), then drop `await` and the call
  parentheses on `page`/`request`: they are values now, not functions. No
  codemod ships for this.
- **`evidence.trace` moved off the scenario record onto each step's own
  record.** Anything reading the scenario record's `evidence.trace` needs
  to read the step record of the step that opened a page instead.
- **A sign-off record's filename now carries its condition.** Anything
  reading the old `<feature-basename>.<date>-<sha>.md` shape needs to read
  `<feature-basename>.<date>-<sha>.<environment>.<browser>.md` instead.

## Before 0.0.5

See [CHANGELOG.md](../CHANGELOG.md).
