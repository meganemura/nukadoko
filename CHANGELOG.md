# Changelog

Notable changes to nukadoko. Versions follow [Semantic Versioning](https://semver.org/),
with one caveat stated in the README: while this is 0.x, the public API can
change in any release. That holds for the whole 0.x range, up to 1.0, not
just until 0.1.

## Unreleased

### Breaking

- **BREAKING: nukadoko loads TypeScript through Node's own type stripping, needs Node `^22.18.0 || >=23.6.0`, and no longer depends on tsx.**
  These are the first Node releases that strip types with no flag. The
  config, the step files, and what they import load through a
  `module.registerHooks` resolve hook, which gives every load its own
  module graph (the cache isolation tsx's namespaces gave) and maps a
  relative `.js` import to the `.ts` file when no `.js` file exists. Run
  workers and the session daemon start as plain `node --import` of that
  hook. Installing the package no longer pulls in tsx and esbuild, so an
  install with `--ignore-scripts` runs the whole walkthrough. What a
  project sees: `enum`, `namespace`, and parameter properties fail to
  load; a type imported without `type` fails to load; `tsconfig.json`
  `paths` and `baseUrl` no longer resolve at run time; a `.ts` file in a
  `package.json` with no `"type"` loads with Node's
  `MODULE_TYPELESS_PACKAGE_JSON` warning instead of failing. docs/upgrading.md
  says what to do about each.
- **`step-file-import-failed` names the line and the cause of a syntax error.**
  The message now carries `(<file>:<line>)` for any syntax error Node
  locates, and `line` is set when that location is the step file itself. A
  V8 compile error (a redeclared name), which carries no location in the
  caught error, is located by importing the same file in a child process
  that evaluates nothing. Syntax that type stripping refuses
  (`ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`) gets a sentence that says what to
  write instead and to set `"erasableSyntaxOnly": true`; on Node 23.x,
  whose report frames the message and names no file, the message line and
  the sentence are kept and no line is claimed. The code is
  unchanged. A config that fails to import gets the same location and
  sentence. The sentence that says to rename a `.ts` file to `.mts` is now
  added only when `package.json` says `"type": "commonjs"`, and names that
  field; with no `"type"`, Node loads the file, so a failure there has
  another cause.
- **`nuka scaffold` writes relative imports with the `.ts` name** (`--command`'s
  run file, `--then`'s upstream step), the spelling Node resolves without
  nuka's hook. **`nuka init` adds `"rewriteRelativeImportExtensions": true`**
  to a `tsconfig.json` that has `compilerOptions` of its own and names
  neither that option nor `allowImportingTsExtensions`, in place, with the
  same layout rules as the `include` edit, and prints `tsconfig.json` when
  it wrote either edit.
- CI adds a packed-tarball job that installs the packed package with
  `--ignore-scripts` and runs the walkthrough on Node 22.18.0 and 26.

### Added

- **`nuka check` warns `scenario-without-then` and `outline-rows-share-name`.**
  A scenario with a Given or a When and no Then passed whenever its steps
  ran without an error, and an outline whose name holds none of its
  Examples columns put every row under one name in the run summary. Both
  are read from the feature file alone and are warnings, so neither changes
  the exit code. A `*` line counts as no position, and a scenario of only
  `*` lines is left alone. `outline-rows-share-name`'s `do` names the
  outline with its first column added.

- **Every `nuka check` and `nuka tend` finding carries `file` and `do`.**
  `do` is the next step: a command with its values filled in where the
  finding knows them (`undefined-step` gives `nuka scaffold --feature
  <its file>`, `playwright-missing` the install line, `features-dir-missing`
  the `mkdir` for the configured directory), and otherwise the code's
  general text from the registry. A finding about one step, which used to
  name only `step`, now also names the step file in `file`, root-relative.
  A tend finding about a config entry (a fixture, a parameter type, a
  secrets key) names the config file. Text output prints `  do: <text>`
  under each finding line, and the third column of a step finding is now
  the step file. `nuka check --codes` and `nuka tend --codes` add each
  code's general `do` as a `do` field in `--json` and a fourth column in
  text, and the llms.txt code tables gain a Do column. `nuka steps --json`
  and `nuka describe` add `file`, the step file. A compat hook finding has
  no `file`, because discovery does not record the file that registered a
  hook. docs/upgrading.md says what a script reading text output does.

- **`nuka scaffold --feature <path>` writes a stub for each undefined line of a feature.**
  A sentence used to be typed twice, once in the feature and once in
  `--pattern`. The command runs the analysis `nuka check <path>` runs and
  writes one step file for each line it reports as `undefined-step`. The
  pattern is the line as cucumber-expressions' own generator reads it over
  the project's registry (built-ins, `config.parameterTypes`, compat
  `defineParameterType`): a quoted value becomes `{value:string}`, an
  integer `{value:int}`, a decimal `{value:float}`, keyed `value`,
  `value2`, and so on. A Then line, with its And and But lines, gets the
  `--then` template. The name is the pattern's literal words in kebab-case,
  with `-2`, `-3` past a name the project already defines or a file the
  steps directory holds, and lines that read as one pattern share one file.
  A capture is written only when the reading ends one way: when a line
  reads more than one way (a registered type and a built-in both fit) or
  the reading would also match another line of the project, the stub's
  pattern is the line as written, escaped, with no capture, and a `note:`
  line on stderr names it. An outline line whose Examples rows read as
  different patterns gets no file and a note. Each written path goes to
  stdout, exit 0. The command refuses, with nothing written, while a step
  file does not import (which lines are undefined is then unknown), and
  `--feature` beside a step name, `--pattern`, `--then`, `--command`,
  `--from`, or `--description` is a usage error. `nuka scaffold` with
  neither a name nor `--feature` says `Missing required argument: name
  (or --feature <path>)`.
- **`nuka tend --codes [--json]` lists every code a tend finding can carry.**
  It mirrors `nuka check --codes`: one line per code, code ascending, as
  `code`, `default` or `--all`, and a one-line description; `--json` prints
  `{ schema_version, codes }`, each code `{ code, description,
  reportedByDefault }`. `reportedByDefault` is
  false for `schema-field-undescribed`, which a run reports only under
  `--all` or when `--fail-on` names it. It answers
  before the project loads, so it works while the config is broken. The
  codes now live in one registry (`src/tend/codes.ts`), and a tend finding
  whose code is not registered fails to compile; `--fail-on` and `--all`
  read the same registry.
- **llms.txt carries the `nuka check` and `nuka tend` code tables.** A new
  "Findings" section holds both, between generation markers.
  `node scripts/llms-codes.ts` (after `npm run build`) rewrites them from
  the built CLI's `--codes --json`, and `tests/llms-codes.test.ts` fails
  while either table differs from its registry.
- **Every JSON document starts with `schema_version`, and records name the nukadoko version that wrote them.**
  No document said which shape it held, and `nuka steps --json` and a
  step record's `used` had already changed shape with nothing an old
  reader could test. Step records, scenario records, and the output of
  `check --json`, `check --codes --json`, `steps --json`, `describe`,
  `tend --json`, `tend --codes --json`, `clean --json`, `explore
  --json`, and `session list --json` now begin with `"schema_version": 1`, one number per kind of
  document, kept in `src/record/schema-version.ts`. A number moves when a
  field changes meaning, type, or name, or is removed; an added field
  does not move it. The step and scenario records also carry
  `nukadoko`, the package version. `check --codes --json` and `session
  list --json` printed bare arrays, which have no place for the key, so
  they now print `{ schema_version, codes }` and `{ schema_version,
  sessions }`, and `tend --codes --json` prints `{ schema_version, codes }`
  from its first release. Breaking for a reader of those two: see
  docs/upgrading.md. The experimental MCP and WebMCP tool lists are the
  server's own shape and stay as they were.
- **`nuka run` writes `run.json`, and `nuka run --json` prints it.**
  The run id, the failed scenarios, their rerun commands, and the summary
  path were prose on stderr only, and the run's own marker held three
  fields. Every run that selects a scenario now writes
  `records/runs/<run_id>/run.json`: `schema_version`, `nukadoko`,
  `run_id`, `verdict`, `started_at`, `finished_at`, `environment`,
  `counts` (`scenarios`, `passed`, `failed`), `scenarios` (each with its
  `scenario_record_id`, `feature`, `line`, `scenario`, `status`, root-relative
  `record` path, and the same `rerun` command stderr prints), and the
  `summary` path. Serial and concurrent runs write it the same way, as the
  run's last write before retention. The new `--json` flag prints that one
  document on stdout in place of the scenario record stream; stderr is
  unchanged, and its paths block gains a `run` line naming the file. It
  replaces `complete.json`, whose fields it carries, so there is one file
  that says a run ended rather than two that could disagree. Breaking for
  a reader of `complete.json`: see docs/upgrading.md.
- **`nuka scaffold --then` writes an assertion when the step has one capture.**
  The body used to throw `not implemented`, and the skill's model for an
  assertion was Playwright's `expect`, which a CLI or API project does not
  install. With exactly one capture (the expected value) and at most one
  `--from`, the body is now `const actual = <the --from key>;` and
  `assert.equal(actual, <capture>, ...)` from `node:assert/strict`, with
  the message `<key>: expected <value>, got <actual>`, which is the line
  `nuka run` prints when the step fails. Without `--from`, `actual` is
  `undefined` under a TODO, so the step still fails until it reads the
  observed value. A custom parameter type compares with `deepEqual`. The
  Then stubs `nuka scaffold --feature` writes get the same body. More
  captures or more `--from` values keep the stub. With the assertion body,
  an args key named `assert` or `actual` is refused, and a `--from` step
  named `assert` is imported as `assertStep`. The acceptance skill now
  says why `--command` leaves `mutates` at `true`: scaffold cannot know
  whether the program writes past the scratch directory.

- **A command run where no config file exists says so on stderr, and names a config in a parent directory.**
  From a workspace root, every command used to answer for an empty default
  project and name only `features`. Now `check`, `run`, `steps`,
  `describe`, `do`, `harvest`, `explore`, `clean`, `tend`, each `session`
  subcommand, `experimental webmcp-tools`, and `scaffold` write one line to
  stderr when the directory they run in has neither `nukadoko.config.ts`
  nor `nukadoko.config.mts`: `no nukadoko.config.ts or nukadoko.config.mts
  in <dir>; nukadoko's defaults apply (featuresDir "features")`. When a
  parent directory up to the nearest one holding `.git` has a config, the
  line continues `; one exists at ../../nukadoko.config.ts: run nuka from
  that directory`. nukadoko still never reads a parent's config. stdout,
  `--json` output, and exit codes are unchanged, except for `scaffold`
  below. `init` prints no line.

### Removed

- **BREAKING: `defineStep`'s `rationale` option, and the tend codes that asked for it or repeated `nuka check`.**
  Projects wrote `rationale` on every step only to quiet `nuka tend`, and
  the one place it showed was `nuka describe`. `rationale` is gone from
  `defineStep`'s input type and from `Step`, so a step file that still
  passes it fails `tsc` with an excess-property error; at run time the
  value is ignored. `nuka describe` prints no `rationale` key. `nuka
  tend` drops `step-rationale-missing`, its `summary.rationale` in
  `--json`, and the `rationale` count on the `declared:` line, which now
  reads `declared: describe <n>/<total>`. It also drops
  `additional-feature-dir-missing` and `import-failures-unseen`, which said
  what `nuka check` already reports as `additional-feature-dir-missing` and
  `step-file-import-failed`; both stay in `nuka check`. `nuka tend` reports
  12 codes, and `--all` adds only `schema-field-undescribed`. `nuka tend
  --fail-on` refuses each of the three removed codes by name, exit 1, with
  what to do instead. The refusal of an unknown code now ends with
  "`nuka tend --codes` lists every code." instead of listing the codes
  inline. docs/upgrading.md says what to change.
- **`nuka experimental webmcp-tools`, `experimental_callWebmcpTool`, and
  `nuka experimental mcp-tools` are gone.** No agent and no CI job used
  them, and an agent's MCP host already lists a server's tools. A step
  that wants a page's declared WebMCP tool can call
  `page.evaluate(() => navigator.modelContext...)` itself. The
  `WebmcpToolDescriptor` type goes with the function, and the hidden
  `nuka mcp-tools` stub that named the `experimental` spelling goes with
  the command. `nukadoko/mcp` (`connectMcpServer`, `callMcpTool`) stays.
  `nuka experimental` now holds `explore` only.

### Packaging

- **A test keeps the tarball's agent-facing files shipped and their links live.**
  `tests/package-files.test.ts` reads `npm pack --dry-run --json` and fails
  when llms.txt, a skill file, or one of the docs an agent is pointed at is
  left out of the package, or when a relative link in llms.txt or a packed
  Markdown file lands outside the packed files. The two links from
  `docs/releasing.md` to the publish workflow are the named exception: that
  page is read from a checkout. `tests/docs-cli-names.test.ts` also fails
  when llms.txt stops naming a top-level `nuka` command.

### Changed

- **`repeated-scenario-prefix` compares docstrings and tables, and stops at the first When.**
  It grouped steps by sentence text alone, so two scenarios whose steps
  took different docstrings counted as one opening, and the When an
  outline's rows share counted as setup. Two steps now share an opening
  only when their sentence and their docstring or table are the same, and
  an opening ends before the first When or Then. The note adds "The shared
  steps take the same docstring or table." when one is shared. The step
  positions come from the scanned feature files; a record whose scenario
  is no longer there with the same step texts is grouped by text as before.

- **`nuka run` writes its scenario records to stdout only when stdout is not a terminal, or under `--records`.**
  In a terminal, one JSON line per scenario sat between a person and the
  progress they were reading, and the README had to explain it away. The
  records are on disk either way, and the `scenarios` line on stderr names
  their directory. A pipe, a file, an agent's shell, and a CI log are not
  terminals, so they get the same NDJSON stream as before without asking.
  The new `--records` flag writes the stream to a terminal too, for a tool
  that drives `nuka run` through a pseudo-terminal. The rule holds under
  `--concurrency`; worker processes are always piped. `nuka do`'s step
  record on stdout is unchanged. Breaking for a pseudo-terminal driver
  that parses stdout: see docs/upgrading.md.
- **One word for each concept across the JSON nukadoko writes.**
  A step record that passed said `"status": "ok"` while its entry in the
  scenario record said `"passed"`, so an agent had to special-case one of
  them. Step records, scenario record hooks, and
  `nuka experimental explore --json`'s steps now say `"passed"`; a stored record that still says `"ok"` is read
  as `"passed"` by `nuka do --use`, `nuka harvest`, and the emitters. The
  exported type `StepRecordOk` is renamed `StepRecordPassed`. `nuka tend
  --json`'s summary keys are snake_case (`typed_steps`, `compat_steps`,
  `compat_step_names`, `scanned_feature_dirs`, `read_only_steps`), like
  every other document. `nuka describe` shows `from` as `{ step, key }`
  (or an array of them), the shape `nuka steps --json` already used,
  instead of a `"step.key"` string. `nuka init --env` is renamed
  `--env-files`, since `--env` names an environment on every other
  command; the old spelling exits 1 and names the new one. Breaking: see
  docs/upgrading.md.
- **`nuka explore` is now `nuka experimental explore`, and the model API
  carries the `experimental_` prefix.** The functions are
  `experimental_defineModel`, `experimental_modelCommand`,
  `experimental_defineRelation`, and `experimental_relationEntry`; the
  types (`Model`, `Relation`, `Draw`, and the rest) keep their names. The
  command, the functions, and the four `explore-*` findings now carry no
  stability promise: they can change or go in any release without a
  deprecation notice, and the word is at every call site. `nuka explore`
  exits 1 and names the new spelling. The flags, the output, and the
  findings are unchanged. Breaking: see docs/upgrading.md.
- **`undefined-step` names `nuka scaffold --feature <file>`.** The message
  ends with "run `nuka scaffold --feature <the line's feature file>` to
  add one" instead of "run `nuka scaffold <name>` to add one". The code,
  `file`, `line`, and the hint and unbound-step suffixes are unchanged.
  The `error.message` of an undefined step in a `nuka run --no-check`
  scenario record names the same command with the scenario's feature file.

- **The `playwright` peer range is `^1.61.1`, not the exact `1.61.1`.**
  npm refused (`ERESOLVE`) to install nukadoko beside any other Playwright,
  so a project on a later 1.x had to downgrade. The devDependency stays
  exact at 1.61.1, the version CI runs, and `playwright-missing` and the
  run-time install line still name it. `npm run pack-check` now installs the
  tarball beside Playwright 1.64.0 and runs `nuka init`, `nuka check`,
  `nuka run`, and `tsc` with `skipLibCheck: false` there.

- **`nuka scaffold` refuses to write when a parent directory has the config.**
  A step file written below the directory that holds the config is not
  one that config reads. The refusal names the directory and the relative
  path to the config, exits 1, and writes nothing. Without a
  parent config, `scaffold` writes as before and prints the stderr line.

### Removed

- **BREAKING: `nuka harvest` and the `recordStep` export are removed.**
  `harvest` printed a draft whose keywords were `*`, whose names were
  placeholders, and whose claims were blank. The agent that ran the `nuka
  do` sequence already knows each step and its args, and the claims are
  the part the draft could not supply. Write the scenario from the steps
  that ran, then run `nuka check`. `nuka harvest` now exits 1 and names
  docs/upgrading.md. `recordStep` existed so a Playwright Test spec could
  write step records for `harvest`; it goes with it, together with its
  `RecordStepOptions`, `StepExecution`, and `UnsupportedExternalFixtureError`
  exports. A spec calls the shared function directly instead, as
  docs/migration-playwright-test.md describes. `retention.adHocDays` stays,
  since `nuka do --use` still reads ad-hoc records across days. A step
  record that `recordStep` wrote keeps `kind: "external"` on disk until
  retention removes it. Breaking: see docs/upgrading.md.

### Fixed

- **docs/spec.md no longer lists a `rationale` key in the `nuka tend --json` summary.**
  The key went away with `defineStep`'s `rationale` option; the summary
  keeps `describe` as its one `{ declared, total }` count. The acceptance
  skill now also says what to add when `nuka check` warns
  `scenario-without-then`.

- **Tests that a loaded machine failed now assert an ordering or an event instead of a duration.**
  This changes the test suite only. The compat timeout tests in
  `tests/compat-run-scope.test.ts` held their slow step or hook on a sleep
  and bounded how long the run took. The step now waits on a promise only
  the test settles, so the run returning at all, with the step still held,
  shows the timeout cut it off. The bare `@serial` test in
  `tests/run-concurrency.test.ts` now has every scenario wait until all
  three have started, instead of comparing timestamps, and the
  `--concurrency 1` comparison no longer compares each step's measured
  duration. The spawned-process waits in
  `tests/run-fixture-signal-teardown.test.ts` and
  `tests/explore-fixture-scope.test.ts` drop their own 5 to 20 second
  deadlines: each waits for its event, fails at once if the child exits
  first, and leaves a hang to the test's timeout. The `nuka scaffold
  --pattern` text property gets the five-minute budget its sibling
  property already had, and, like it, turns off Hegel's TooSlow health
  check, which a loaded machine failed with only 4 cases done in its 30
  seconds.

- **Discovery, the `.feature` walk, and the oath walk follow symbolic links.**
  A step file, a feature, or a directory linked into `featuresDir` (a
  monorepo's shared steps, for example) used to be skipped with no report,
  so its steps turned up as `undefined-step` with a scaffold hint and its
  scenarios never ran. Each walk now follows a link and enters a directory
  once, so a link back up the tree does not loop. A link whose target is
  missing is passed on: `nuka check` reports a step file as
  `step-file-import-failed` and a feature as a parse error, each naming the
  link.

- **`nuka check` and `nuka tend` read a feature reached by two paths once.**
  A feature linked into `featuresDir` and also present under an
  `additionalFeatureDirs` entry was parsed twice, so each of its findings
  appeared twice, once per path. The walk now tells files apart by their
  real path and reports the file under the first path it reached, which is
  the one under `featuresDir`. An oath named twice through a link is one
  document the same way.

- **`nuka check` names a `.cts` step file as `step-file-unsupported-extension`, the same as a `.cjs` file.**
  A `.cts` file is CommonJS by extension, so discovery never imports it.
  Before, discovery skipped it without a word, and every step it defined
  turned up as `undefined-step` with a scaffold hint. The finding message
  now names the file's own extension. Discovery also skips a `.d.cts` type
  declaration, as it already skips `.d.ts` and `.d.mts`.
- **The Allure report places a step with no step record where the cucumber-messages stream does.**
  A skipped, undefined, or ambiguous step, or one refused before it began,
  has no time of its own. The Allure emitter put it at the wall-clock
  moment the runner appended it, which record.json never stores, while the
  messages emitter put it at the previous step's stop. One scenario record
  gave two timelines. Both emitters now place such a step zero-width at the
  previous step's stop, or at the scenario's `started_at` for the first
  step, through one shared function, so either report can be rebuilt from
  record.json alone.

- **A drafted scenario whose docstring holds the text `\"\"\"` reads back as written.**
  `nuka explore` writes each docstring between `"""`
  fences, and @cucumber/gherkin turns the first `\"\"\"` on any line
  inside those fences into `"""`. A docstring value that held that text
  read back different, and its line was written with a comment saying
  so. The draft now fences such a docstring with backticks. A
  value that holds both `\"\"\"` and `` \`\`\` `` fits neither fence, and
  its line still gets the read-back comment.
- **The Playwright migration guide describes the peer range as it is.**
  docs/migration-playwright-test.md said nukadoko names one exact
  Playwright version, so a project on a later 1.x would read that it had
  to downgrade. The peer is the range `^1.61.1`, and the guide now says
  that npm refuses only a Playwright outside it.

## 0.16.1 — 2026-10-17

### Fixed

- **A test helper no longer empties the shared `nukadoko` shim while another test imports it.**
  The release checks for 0.16.0 failed on `nuka init`'s `.gitignore`
  property test: the helper rewrote the shim's files in place, and a
  test that loaded a generated config in that moment read an empty
  module. The helper now leaves unchanged content alone and moves new
  content into place by rename. 0.16.0 never reached npm, so 0.16.1 is
  the first published version with the 0.16.0 changes below. The
  package's own code is the same as 0.16.0.

## 0.16.0 — 2026-10-17

### Added

- **`undefined-step` names the patterned steps no scanned feature line binds, and `pattern-unbound` carries the step file.**
  After a sentence or a pattern is renamed, one feature line is undefined
  and one step is unbound at the same time. `nuka check` used to say only
  "run `nuka scaffold <name>`", which writes a duplicate. Each
  `undefined-step` message now ends with `; patterned steps no scanned
  feature line binds:` and up to three steps in vocabulary order, each
  with its patterns and its root-relative file, then `and N more`. The set is judged on the
  directories `tend` scans (featuresDir, additionalFeatureDirs, oaths),
  also when a target selects fewer files: a step bound in a file the target
  left out is not unbound, and `nuka run`'s findings stay equal to `nuka
  check`'s for the same target. A project with no unbound patterned step
  keeps the message it had. `nuka tend`'s `pattern-unbound` note now sets
  `file` to the root-relative step file, in `--json` and in the text
  line's location column. Both commands read one list, so they name the same steps on the
  same files. Finding codes are unchanged.

- **`nuka scaffold <name> --description <text>` writes the step's description, and `nuka tend` notes one still at its TODO.**
  The text is written as a JSON string literal in place of
  `TODO: describe <name>`, and in place of `--command`'s own sentence
  when both are given. The flag is refused when given twice or empty.
  Without it, the TODO used to pass `nuka steps`, `nuka check`, `nuka
  tend`, and a green run with no word. `nuka tend` now reports
  `step-description-todo` in its default set, one note per typed step
  whose `description` begins with `TODO: describe`, with the step's file;
  `--fail-on step-description-todo` turns it into exit 1. It is a note,
  not a `check` finding, because the step runs. The README walkthrough
  passes `--description` to the Then step, and the acceptance skill says
  the CLI is run as `npx nuka` from the project that installed it.

- **`nuka check` reports a step that needs Playwright the project has not installed.**
  When a checked feature line binds a step whose fixtures build `page`,
  `context`, or `request`, directly or through `config.fixtures`, and
  `playwright` does not resolve from the installed nukadoko, `check` reports
  the error `playwright-missing` once per step, at the first line that binds
  it, with the same text the run throws: `ctx.request() in "When ..." needs
  "playwright", and this project has not installed it. Install the version
  nukadoko is tested against: npm install -D -E playwright@<version>`. So
  `nuka run` stops before any step runs, where it used to start and fail at
  the first such step. The check resolves the package and does not load it,
  and it resolves nothing when no bound step needs it. A `config.fixtures`
  entry named `request` that does not destructure `request` replaces the
  builtin and is not reported. A step that no checked line binds is not
  reported, so a run of a command-line scenario is not stopped by a browser
  step file beside it. `nuka run --no-check` keeps the run-time failure.
- **`nuka scaffold <name> --command [<entry point>]` writes the When step of a command-line program.**
  The step runs `runCommand(process.execPath, [cli, ...args], { cwd:
  scratch.dir() })` with the pattern's captures as argv (a capture that is
  not a string is passed as its text), and declares `returns` of
  `exitCode`, `stdout`, and `stderr`. So `nuka scaffold <then-step> --then
  --from <name>.stdout` (or `.exitCode`, `.stderr`) works right after it,
  with no hand edit in between. The flag's value is the entry point,
  written as `const cli = resolve("src/cli.ts")` (a JSON string literal,
  so a quote or a backslash in the path is escaped), so the walkthrough's
  When step needs no edit at all. A value that is not a regular file
  under the directory `nuka` runs in, a typo (`src/clli.ts`) or a
  directory (`src`), is refused with nothing written: `Refusing to
  scaffold: entry point "src/clli.ts" is not a file (looked at
  <absolute path>); ...`. Such a value used to pass `nuka check` and the
  When step, and surface as an empty `stdout` in the next step. When
  `--command` comes before the name, the parser takes the name as its
  value (`nuka scaffold --command run-y --pattern ...`); the refusal, or
  the missing-name error when no other word is left for the name, then
  adds `--command before the name takes the next word as its value
  ("run-y" here); write the name first, or give --command a value`.
  Without a value the line is
  `const cli = resolve("<TODO: the entry point>")`, and `run` throws
  `fill in the entry point: features/steps/<name>.ts:<line>` before it
  calls `runCommand` while that placeholder is there: `nuka check` still
  passes, because the file imports, but `nuka do` and `nuka run` fail by
  name at that step. Before, the step ran Node on a path that does not
  exist, passed with `exitCode: 1`, and the cause showed up only in the
  step record's `stderr` while the next step failed on an empty `stdout`.
  An args key named `Error` is refused in that form too, since the guard
  throws one. `--command` given twice is refused. `--command` with
  `--then` is refused with no file written, because a step that runs a
  program changes state. An args key that would hide a name the written
  body reads (`cli`, `runCommand`, `process`, `scratch`, `String`) is
  refused the same way.
- **A scaffolded stub names its args in the error it throws.** `run({},
  { name })` now throws `` `not implemented: run-greet; args
  ${JSON.stringify({ name })}` ``, so a project that compiles with
  `noUnusedParameters` accepts every scaffolded file as written, and the
  first failed run shows what the feature line bound. A stub with no args
  throws `not implemented: <name>` as before. An args key named `Error`,
  `JSON`, or `String`, which the stub's body reads, is now refused.
- **`nuka check [feature..]` takes the targets `nuka run` takes.**
  Several files, a directory walked for `.feature` files and the oaths
  configured under it, or both, selected by the same code `nuka run` uses,
  so the errors `nuka run <targets>` prints before executing are the errors
  `nuka check <targets>` reports, and a PR gate can name a directory. With
  no target, `nuka check` still checks featuresDir, additionalFeatureDirs,
  and every oath. `:line` is still refused, since check analyzes whole
  files. A selected file that does not parse stays a `feature-parse-error`
  finding beside the other files' findings. The `--json` report keeps its
  shape. A directory argument is no longer refused with "pass a .feature or
  .md file, or use nuka run for a directory". `nuka run` and `nuka check`
  now name a feature file that exists but cannot be read (permission
  denied) with the system error's own text instead of "Feature file not
  found".

- **`nuka scaffold <name> --from <step>.<key>` writes the chain to an earlier step.**
  Repeat the flag for each key. For each one, the scaffolded file imports
  the producer step's file (`./run-greet.js` for `run-greet.ts`, `.mjs` for
  an `.mts` file), adds an args field typed by the producer's own schema
  (`stdout: runGreet.returns.shape.stdout`, so the two cannot drift apart
  and the producer's `.describe()` text shows in `nuka describe`), adds the
  `from` entry, and names the key in `run`'s destructuring. This is the
  part of a Then step a person wrote by hand before, and it combines with
  `--pattern` and `--then`. Scaffold reads the producer through discovery,
  like `nuka steps`, and refuses with no file written when no typed step
  has that name, when the producer's `returns` is not a `z.object` or
  lacks the key (the refusal names the keys it has), when the value is not
  `<step>.<key>` with an identifier key, or when two `--from` values or a
  capture fill the same args key.
- **The README walks through an HTTP API project.** A new section, "An
  HTTP API", shows the config of a project whose server a fixture starts
  once per `nuka run` (`{ scope: "process" }`), the `StepFixtures`
  augmentation `tsc` needs for that fixture, and a When step that calls the
  server with `fetch`. It says that `ctx.request()` needs `playwright` and
  is what counts calls in `observed.http_reads` and `observed.http_writes`,
  and that a `fetch` call leaves both at 0. `tests/readme-api.test.ts`
  compiles the section's blocks under `tsc --strict` and `skipLibCheck:
  false` in a project without Playwright, checks that the compile fails
  without the augmentation while `nuka check` still passes, and runs the
  feature green. README.ja.md carries the same section.
- **The `StepFixtures` augmentation is written down.** "Declaring a
  fixture" in the acceptance skill's `fixtures.md`, "Fixtures" in
  docs/spec.md and docs/spec.ja.md, and the fixture paragraph of
  `writing-steps.md` now show `declare module "nukadoko" { interface
  StepFixtures { ... } }` and say that `tsc` needs it and `nuka check` does
  not. `docs/glossary.json` settles 拡張 for augmentation.
- **A failed step's lines name the step it read from whose program exited nonzero, with the first line of that program's stderr.**
  When a program under test fails to start (a missing build, a missing
  dependency, a `.js` import of a `.ts` file under `node`), the When step
  that ran it still passes, because an exit code is a result, and the Then
  step fails on an empty stdout with no word about why. `nuka run` now
  writes, between a failed step's error line and its `record` line, one
  line per `used` entry whose `result` has a number `exitCode` other than
  0 and a string `stderr` (the shape `runCommand` returns, checked
  structurally): `used    run-greet  exit 1  Error [ERR_MODULE_NOT_FOUND]:
  ...`, or `(no stderr)` when the program wrote nothing visible. The run
  summary's failure cell carries the same fact after the error. The text
  comes from the redacted step record. Nothing is written for an exit code
  of 0 or `null`, or for a result that is not a process result.

### Changed

- **`nuka scaffold --command <entry point>` refuses a TypeScript entry point that plain `node` cannot start.**
  The step runs the entry point with `node` itself, which strips types and
  does not rewrite a `./greet.js` specifier to the `./greet.ts` beside it.
  In a NodeNext project that imports with `.js` specifiers, the scaffold
  used to write a step whose run exited 1 with `ERR_MODULE_NOT_FOUND`
  before the program started. For an entry point ending in `.ts`, `.mts`,
  or `.cts`, scaffold now reads the entry file's own static `import` and
  `export ... from` lines (not type-only ones, not dynamic `import()`, not
  comments) and refuses, with nothing written, when a relative `.js`,
  `.mjs`, or `.cjs` target is absent and its `.ts`, `.mts`, or `.cts`
  sibling is present: `Refusing to scaffold: entry point "src/cli.ts"
  imports "./greet.js", which does not exist (src/greet.ts does); node
  runs a .ts file without rewriting that specifier, so the step would exit
  1 with ERR_MODULE_NOT_FOUND. Point --command at the built program (for
  example dist/cli.js, after npm run build), or import "./greet.ts" with
  "rewriteRelativeImportExtensions": true in tsconfig.json`. It is a
  refusal, not a warning beside a written file, because that file's only
  measured outcome is a red run, and `--command`'s other check on the
  value already refuses. Imports of imported files are not read, and a
  target that exists, or whose sibling is absent too, is not claimed. The
  README walkthrough says the step runs the entry point with `node` and
  that such a project points `--command` at the built program, with
  `"pretest:scenarios": "npm run build"`. The migration skill's
  `compatibility` line now says the CLI is run as `npx nuka` from a
  devDependency install, as the acceptance skill's does.

- **`step-file-import-failed` names the `.ts` file a missing `.js` import stands for.**
  A step file imports another as `./run-greet.js` for `run-greet.ts`, the
  way the scaffold writes it. When `run-greet.ts` was renamed or deleted,
  `nuka check` printed only Node's text, which names the absolute `.js`
  path that never existed. After that text it now appends `;
  features/steps/run-greet.js stands for features/steps/run-greet.ts,
  which does not exist; update the import in
  features/steps/output-says.ts`, with both paths relative to the project
  root. The loader's own mapping decides the file (`.js` to `.ts`, `.mjs`
  to `.mts`, `.cjs` to `.cts`). Nothing is appended when that file exists,
  for a path inside `node_modules`, or for a missing package. The finding
  code and `line` are unchanged.

- **`nuka scaffold --pattern` refuses a capture type the project does not register.**
  `{a:number}` used to be written as `a: z.unknown()`, and the next
  `nuka check` reported `unknown-parameter-type`, so `nuka run` refused to
  start; fixing the pattern in the step file then left `z.unknown()`
  behind. scaffold now reads the pattern against the registry `nuka check`
  builds (the built-in types, `config.parameterTypes`, and each compat
  `defineParameterType` in the step files) and refuses with nothing
  written: `Refusing to scaffold: the pattern names type "number", and
  this project registers none by that name; registered types: bigdecimal,
  biginteger, ..., word; did you mean {a:int} or {a:float}?`. The hint is
  for `number` only. A custom type the project does register is still
  written as `z.unknown()`. A config that fails to load is reported as
  such before the type is looked up. The step files are imported for
  this only when the pattern names a type the built-ins lack.
- **nukadoko runs tsx with its disk cache off.**
  tsx reads the whole index of its cache directory under the OS temp
  directory when it starts. That index is shared by every tsx user on the
  machine and only grows, while nukadoko transforms only the config and the
  step files. nukadoko now sets `TSX_DISABLE_CACHE=1` before it first loads
  tsx, so `nuka check`, `nuka run`, the `--concurrency` workers, and the
  `nuka session` daemon skip the read and write no cache entries. A value
  you set yourself is kept; tsx treats any non-empty value as "off", so set
  `TSX_DISABLE_CACHE=` (empty) to keep tsx's cache on. Measured on Node
  24.22 with a cache directory of 261k entries, against a one-feature
  project, 11 interleaved runs each, median wall clock before and after:
  `check` 1513 ms to 1320 ms, `run` 1649 ms to 1486 ms. No command, flag,
  or output changes.
- **A command loads only its own modules, and `nuka run` imports each step file once.**
  Each command's module now loads when that command runs, so `nuka
  --version` and `nuka --help` no longer load the run engine, the report
  emitters, the compat layer, or the MCP client: 51 modules instead of
  459. `nuka run` used to import every step file twice, once for the check
  and once to execute; it now executes the modules the check imported, so
  a step file's module-scope code runs once per run (with or without
  `--no-check`), and the second copy of nukadoko that each import pulled
  in is gone. On a one-scenario project with two step files, `nuka run`
  loads 832 modules instead of 1101 and imports a step file 2 times
  instead of 4; `nuka check` loads 728 instead of 885. Measured on Node 24.22 against a
  one-feature, two-step-file project, 15 interleaved runs each, median
  wall clock before and after: `--version` 349 ms to 100 ms, `--help` 336
  ms to 106 ms, `check` 1283 ms to 1221 ms, `run` 1687 ms to 1461 ms, `run
  --no-check` 1448 ms to 1395 ms. What is left on `run` is module loading
  and the TypeScript transform of the step files and the config. No
  command, flag, or output changes.
- **`playwright` is an optional peer dependency, so a project that never opens a browser installs no browser stack.**
  `playwright` moves from `dependencies` to `peerDependencies` at the same
  exact version (1.61.1), marked optional; `npm install -D nukadoko` no
  longer brings in `playwright` or `playwright-core`. nukadoko loads it
  when a `page`, `context`, or `request` fixture is first built, and when
  `nuka experimental webmcp-tools` launches its browser, never when a
  command starts, so `nuka init`, `nuka scaffold`, `nuka check`, and a run
  of steps that use none of them work without it. When it is missing, the
  step that asked fails with one line: `ctx.page() in "<step>" needs
  "playwright", and this project has not installed it. Install the version
  nukadoko is tested against: npm install -D -E playwright@1.61.1`
  (`ctx.request()` for a request step). Only Node's own
  `ERR_MODULE_NOT_FOUND` for `playwright` itself gets that message; any
  other load failure keeps its own error. Type declarations still name
  Playwright's types through `import type`, and the build puts a `//
  @ts-ignore` line before each of those imports in the shipped `.d.ts`
  files, since declaration emit drops one written in the source. Without
  the package those types become `any` whatever `skipLibCheck` says, so a
  project's own `tsc` passes under a strict tsconfig with `skipLibCheck:
  false`; with it installed, `page` is Playwright's `Page` as before.
  Breaking: a project with browser or HTTP
  steps adds `playwright` to its own devDependencies, and npm refuses to
  install nukadoko beside a different `playwright` version
  (docs/upgrading.md).
- **`nuka init` adds the steps and the config to `tsconfig.json`'s `include` itself.**
  It used to print a line naming the entries and leave the edit to a
  person, the one hand edit of a config file left in the walkthrough. Now,
  when the `include` array of `tsconfig.json` leaves out
  `<featuresDir>/**/*` or the config file, `init` appends the missing
  entries in the array's own layout (one per line, or on the same line,
  with the same indentation and line endings), changes no other byte, and
  prints `tsconfig.json` on stdout with the other written paths. This holds
  for the JSONC dialect `tsc --init` writes too: comments stay where they
  are (a comment that ends the last element's line stays on that line),
  a comment holding `[` or `"include"` does not move the edit, and an
  array that ends in a trailing comma keeps one after the new last entry.
  The stderr line that named the entries for a file with comments is gone.
  A tsconfig with no `include` of its own (TypeScript's default, or one
  inherited through `extends`), one whose `include` already covers both
  paths, and one that does not parse are left alone with nothing printed,
  as before.
- **`nuka init` recognizes an existing ignore line for `.nukadoko`, and says when it keeps another `test:scenarios` script.**
  `init` compared whole `.gitignore` lines, so a project that already
  ignored `.nukadoko` (no slash) got a second line, `.nukadoko/`. A line
  that names the state directory with or without a leading `/`, a trailing
  `/`, or a trailing `/**` now counts, and `.gitignore` is left
  byte-identical; a negated line or any other glob does not count. When
  `package.json` already has a `test:scenarios` script that is not `nuka
  run`, `init` still leaves it as it is and now prints one stderr line:
  `package.json already has a test:scenarios script ("cucumber-js"); nuka
  init left it as it is, so run "nuka run" directly or point that script
  at it`. A script that already is `nuka run` gets no line.
- **`nuka run` performs the static check first, and runs `featuresDir` with no target.**
  Before it executes anything, `nuka run` now reports what `nuka check`
  reports for the scenarios it selected: every project-wide finding, plus
  the scenario-level findings for the scenarios it is about to execute (a
  `:line` target narrows only that part). When one is an error it prints
  the errors on stderr in `nuka check`'s own format, then `nuka run did not
  start: nuka check reports <n> errors for these scenarios. Fix them, or
  pass --no-check to run anyway.`, writes no record, and exits 1. Warnings
  are not printed and do not stop a run. `--no-check` skips the check.
  `nuka run` with no target runs `featuresDir` instead of exiting 1, and
  `nuka init` writes `"test:scenarios": "nuka run"` instead of `"nuka
  check && nuka run <featuresDir>"`. Before this, an undefined step, a
  mutating step in Then position, or a `from` binding out of order was
  caught only when a second command was chained in front of the run,
  which every adopter wrote by hand. Breaking: a feature `nuka check`
  rejects no longer runs, and a run-scope error such as `duplicate-pattern`
  now stops every run; see docs/upgrading.md. `nuka check` stays for a
  seconds-long gate and for `additionalFeatureDirs`.
- **`nuka tend` reports only structural rot by default.** The two
  declaration notes, `step-rationale-missing` and
  `schema-field-undescribed`, are left out of text and `--json` output
  unless `--all` is given or `--fail-on` names the code. A fresh project
  got only these notes, one or two per step, and teams wrote placeholder
  rationale strings to quiet them. The `declared:` summary line still
  counts both and, when notes were left out, adds `(nuka tend --all names
  each one)`. Unused declarations, unbound steps, stale fixtures, and every
  other finding are reported as before. Breaking for a script that reads
  either code from plain `nuka tend --json`: add `--all`
  (`docs/upgrading.md`).
- **`nuka scaffold` no longer writes a commented-out `rationale` line.**
  The template's comment pointed at the note `nuka tend` no longer prints
  by default.
- **The acceptance skill drops `nuka tend` from the per-pull-request
  loop.** It runs as the scheduled CI job (`docs/ci.md`); an agent runs it
  when asked.
- **`nuka --help` groups its commands, the everyday loop first.** The flat
  list of fifteen commands is now four groups: Everyday (`init`,
  `scaffold`, `check`, `run`, `steps`, `describe`), Exploring (`do`,
  `session`, `harvest`, `explore`), Upkeep (`tend`, `clean`, `skill`), and
  Experimental. yargs has no grouping for commands, so the top-level list
  is rendered from one table in `src/cli/help-groups.ts`; each command's
  own `nuka <command> --help` keeps its description.
- **`nuka mcp-tools` moved to `nuka experimental mcp-tools`.** Listing
  another MCP server's tools is not part of the everyday loop, and the top
  level now shows only what a newcomer needs. The old spelling exits 1 and
  names the new one. `docs/upgrading.md` has the one-line change.
- **The README starts with a CLI walkthrough.** After Install, "Beside your
  unit tests" adds one scenario to a CLI project: `nuka init`, a When step
  scaffolded and filled in with `runCommand` and `scratch`, a Then step
  scaffolded with `--then --from run-greet.stdout`, a two-line feature,
  `npm run test:scenarios`, what a failure prints on stderr and in the run
  summary, the CI line, and what to commit. Every output block is from a
  real run of the packed tarball, and a test runs the walkthrough's own
  commands and files in a scratch project. "More" links the rest; the
  install details moved to "Setup details". `README.ja.md` and the
  acceptance skill follow: the skill's loop opens with its four everyday
  steps, and its browser and session warnings apply only when a step needs
  `page` or the loop reaches `session`.
- **examples/todo/README.md matches 0.15.** Its prerequisites no longer
  describe nukadoko as unpublished: from a checkout, `npm install` and
  `npm run build` at the root, then `npx nuka` from the example. Part 1
  now sets `features/explore` aside together with `complete-todo.ts`,
  since the model imports that step and `nuka check` would otherwise
  report the failed import instead of the missing step. Its scaffold step
  is `nuka scaffold complete-todo --pattern "..."`, and the check output,
  the scaffolded file, and the implemented step it shows are what the CLI
  prints and the example ships today; `tests/examples-todo.test.ts` runs
  the commands and compares.

### Fixed

- **A project with `declaration: true` compiles a step that declares no `returns`.**
  The package entry now exports `DefaultReturns` and `StepRunResult`, the
  two names `defineStep`'s signature reaches that it did not export. A
  step's `.d.ts` is inferred from `defineStep`, so in a project that emits
  declarations (what `tsc --init` writes, and every library and every
  `composite` workspace) every `--then` step, every plain stub, and every
  hand-written step without `returns` failed `tsc` with TS2742 or TS2883:
  the inferred type could not be named without a path into
  `node_modules/nukadoko/dist/step/define-step.js`. It is now written as
  `import("nukadoko").DefaultReturns`. The declarations test compiles each
  shape `nuka scaffold` writes and the config `nuka init` writes under
  `declaration`, `declarationMap`, and `composite`, and `npm run
  pack-check` does the same against the packed tarball.

## 0.15.0 — 2026-10-16

### Added

- **`runCommand` runs a command-line program and records it on the step record.**
  `import { runCommand } from "nukadoko"` takes `(command, args, { cwd, env,
  input, timeout })` and resolves to `{ exitCode, signal, stdout, stderr }`.
  A nonzero exit resolves like any other; it rejects only when the program
  cannot start or `timeout` stopped it. Projects that test a CLI each kept
  their own `spawnSync` wrapper, and the step record could not show that a
  process ran. Now each call inside a step's `run`, a part, or a compat
  step adds `{ command, cwd, exit_code, duration_ms }` (with `signal` or
  `timed_out` when they apply) to the step record's `observed.processes`, in
  call order. The field is absent when no process ran, and the command is
  redacted like the rest of the record. It is an import, not a fixture, and
  a call outside a step records nothing.
- **`nuka run` says on stderr why a step failed and how to rerun the scenario.**
  A failed step's `FAIL` line is now followed by the first line of its
  error message (terminal color codes removed) and the path of its step
  record (`record  <stateDir>/records/steps/<id>`; a step that never began
  has no step record and gets the error line only). After the summary, each
  `failed` line is followed by `rerun  nuka run <feature>:<line>`, with
  `--env <name>` when the run was given one. `--quiet` keeps a failed
  step's lines and the rerun lines, and still drops every other progress
  line; under `--concurrency` the worker's failed step lines reach the
  parent's stderr under `--quiet` too. Before this, the error existed only
  in the stdout NDJSON, so a CI log said `FAIL` and never why. stdout is
  unchanged.
- **A step may omit `returns`, and `nuka scaffold` takes `--pattern` and `--then`.**
  Every assertion step in every adopting project repeated
  `returns: z.object({})`, `return {}`, and `mutates: false`. `returns` now
  defaults to an empty object schema, and a `run` that returns nothing is
  recorded as `{}`. A declared `returns` keeps its meaning, and so does the
  type check on a `from` that names a key the producer cannot return.
  `nuka scaffold <name> --pattern "<text>"` writes the pattern and one args
  field per `{key:type}` capture (the schema of the value a built-in type
  produces, `z.unknown()` for a custom one), and refuses a pattern
  `nuka check` would refuse in any project: an unnamed or repeated capture,
  an unterminated `{`, an empty pattern, or a cucumber-expressions syntax
  error. `--then` writes `mutates: false` and no `returns`, so the file
  passes `nuka check` under a Then line once `run` is filled. The template
  itself is shorter: one comment line per lesson. `mutates` still defaults
  to `true`. A one-parameter `run(args)` was considered and not added:
  `run({ page })` already means a step that needs `page` and no args, and
  TypeScript cannot type one parameter as either. Instead, `nuka check`'s
  unknown-fixture message names the fix when the unknown name is one of the
  step's own args keys: `run({}, { sum })`.
- **`scratch` is a builtin fixture: temporary directories removed when the scenario ends.**
  Projects that ran filesystem scenarios each declared the same fixture in
  `nukadoko.config.ts`, with a `StepFixtures` augmentation, so a first
  config started as a fixture lesson. A step now destructures `{ scratch }`
  with `defineConfig({})`. `scratch.dir(prefix?)` creates an empty directory
  under the OS temporary directory; `scratch.copy(source)` copies a
  directory or a file (relative to the project root) into a new one. Every
  directory is removed when the scenario ends, pass or fail (for `nuka do`,
  when the execution ends; in a live session, when the session ends). The
  step record lists each path under the new `evidence.scratch` field, and
  `nuka steps --json` lists `scratch` under `needs`. A prefix that holds a
  path separator throws `InvalidScratchPrefixError`.
  Not breaking: a project fixture named `scratch` still replaces the
  builtin at run time, and its own `StepFixtures` declaration still
  compiles and still wins. `scratch` is not a member of `StepFixtures`; a
  step's `run` now receives `FixtureBag`, which is `StepFixtures` plus each
  replaceable builtin (`ReplaceableFixtures`) the project did not declare.
  `FixtureBag`, `ReplaceableFixtures`, and `Scratch` are exported types, and
  `InvalidScratchPrefixError` is exported for `instanceof`.
- **`nuka run` writes a Markdown run summary for the person reviewing the run.**
  Every run that runs at least one pickle writes
  `<stateDir>/records/runs/<run_id>/summary.md`, appends the same Markdown
  to the file `$GITHUB_STEP_SUMMARY` names when that is set (GitHub Actions
  sets it, so the job summary shows the run with no configuration), and
  writes it to `--summary <path>` when given, replacing that file. It
  starts with `<!-- nukadoko:run -->` so a CI step can update a pull
  request comment in place. It holds the run's verdict and counts; the
  short commit sha and whether the tree had uncommitted changes; the
  environment, target version, browsers, nukadoko version, run id, and
  times; one table per feature with each scenario record's status,
  duration, and, when it failed, the failing step or hook, the first line
  of its error, the last command it ran through `runCommand` that did not
  exit 0, and the record path; the "Declared vs observed" section; and the `nuka run <feature>:<line>` rerun command
  for each failed scenario. Under `--concurrency` the parent writes one
  summary for the whole run. The output-location lines gain a `summary`
  row. A summary that cannot be written is a stderr warning and never
  changes the exit code; a setup failure writes none. Before this, nothing
  a person could read came out of CI except the stderr tail.
- **A test checks the names the docs give for commands, flags, finding codes, and headings.**
  `tests/docs-cli-names.test.ts` reads README.md, README.ja.md, llms.txt,
  `docs/`, and `skills/`. Every `nuka ...` must name a command and flags the
  CLI has, every code in a registered family must be a `nuka check` or
  `nuka tend` code, and every quoted heading must exist in the file it points
  at. The spec's CLI summary must list every command and flag. Each of these
  drifted before with no test failing.
- **`nuka explore <file>` runs a model or a relation.** A model builds
  each sequence from `draw.int` and `draw.pick` choices taken from one
  `--seed`, runs `--runs` sequences of at most `--length` request-only
  steps, and shrinks the first failure by deleting a step and then
  lowering a choice. Shrinking keeps an edit only when the sequence still
  fails the same way: the same failure kind, and for a `post` failure the
  same command. A process-scope fixture lasts the whole invocation, and
  SIGINT or SIGTERM tears fixtures down as under `nuka do`. `--json`
  prints one object on stdout with the verdict, the seed and counts, and
  on a failure each step's result, the failure kind and message, and the
  scenario. A step whose args take a table or a docstring prints one,
  through the renderer and read-back `nuka harvest` uses. A relation's
  source can be generated, from a function of `draw` or a model's
  commands; it then takes `--seed`, `--runs`, and `--length`, and a
  failing source is shrunk while the relation fails the same way.
  Shrinking also deletes two adjacent steps at once. A relation runs
  its source and its follow and calls `relate`. On a failure stdout gets
  the scenario to paste (two for a relation) and the command that reruns
  it. No step record is written, and nothing is added to a feature. A model's `args` now receives
  `(state, draw)`; a model written for `(state)` still compiles.
  `examples/todo/features/explore/add-model.ts` now adds and completes
  todos.
- **Models and relations are declarations `nuka check` can read.**
  `defineModel(initial).commands(...)` and `defineRelation` name steps by
  basename. `explore-unknown-step` reports a name that is not in the
  vocabulary. `explore-browser-step` reports a step that needs `page` or
  `context`. A request-only step is allowed. Check does not run the steps.
  `examples/todo/features/explore/` is the request-only case.
  `explore-empty-model` reports a model with no commands, whose every run
  passes. `explore-unseeded-random` reports a direct `Math.random` call in
  a command's `args`, `pre`, or `next`, or in a relation's drawn source,
  since the seed cannot replay or shrink that value. Check reads only the
  function's source text, so it stays silent for `crypto.random*` and for
  any binding outside the function, which it cannot see.
- **`nuka steps` and `nuka describe` show a step's declared `timeout`.**
  A step's own `defineStep({ timeout })` deadline was visible only in its
  source, so a reader could not tell which steps run under `stepTimeout`.
  Both `--json` outputs now carry `timeout` in milliseconds when the step
  declares one, and the `nuka steps` text names it on the step's first line
  (`timeout 30000ms`). A step without one shows nothing. The acceptance
  skill now names the typed-step deadline, how to change it, and how to read
  an `error.kind: "timeout"` failure.

### Changed

- **A version bump that lands on main now publishes the npm package.**
  `.github/workflows/publish.yml` runs on a push to `main` that changes
  `package.json`, publishes when no `v<version>` tag exists yet, and then
  creates that tag and the GitHub release on the published commit. Nobody
  pushes a `v*` tag by hand any more. The VS Code extension keeps its own
  `vscode-v*` tag flow.

### Fixed

- **A signal to `nuka run --concurrency` tears every worker down.** The
  parent had no SIGINT or SIGTERM handler. It died at once, with no
  summary, and its workers kept running with their fixtures open. The
  parent now forwards the first signal to every worker, each worker tears
  its fixtures down and exits, no further worker starts, and the parent
  prints the summary and exits with 128 plus the signal number, as at
  `--concurrency 1`. A second signal is forwarded too, and every process
  exits at once. Workers run in their own process group, so a terminal's
  Ctrl-C reaches them only through the parent. A worker whose parent ends
  without forwarding, from a SIGKILL or a killed process group, tears its
  fixtures down on its own, and one whose parent ends after forwarding
  finishes the teardown it started. A worker learns this when its IPC
  channel closes, and its stdin stays empty, so a step that reads stdin
  gets end of file at once. On Windows the parent does not forward,
  because each worker already receives the console's Ctrl-C.
- **SIGHUP tears fixtures down like SIGINT and SIGTERM.** Closing the
  terminal or losing an ssh connection during `nuka run`, `nuka do`, or
  `nuka explore` ended the process with no fixture teardown.

- **Only records reach stdout when a hook, a fixture, or a late step
  writes there.** Text written to the process stdout went to stderr only
  while a step body ran. A Before or After hook, a BeforeAll or AfterAll, a
  fixture's setup or teardown, a World constructor, a step file while it
  loaded, and a step still running after its timeout wrote into the record
  stream. Under `nuka run` the text glued onto the next NDJSON record and
  the run still exited 0. Under `--concurrency 2` the parent read every
  worker line as unreadable and ended with no records and exit 1. `nuka
  run`, `nuka do`, `nuka explore`, and each worker now send every
  `console.log` and `process.stdout.write` to stderr for the whole
  invocation, and write their records through the stream they saved before
  that. A child process spawned with `stdio: "inherit"` still writes to
  stdout directly.

- **`nuka harvest` writes a docstring line that starts with three quotes
  so it reads back.** The line was written as a backslash and three
  quotes, which the Gherkin reader keeps as written, so the draft carried
  a "does not read back to the same args" comment and a pasted line ran
  with a stray backslash. Each quote now gets its own backslash, which
  the reader removes.

- **A live session records a step timeout as a timeout.** A step run
  through `nuka do --session` against a live session that outlived its
  deadline was recorded with `error.kind: "step_error"`, and the message
  named the session instead of the step. It now records `"timeout"` and
  names the step, as `nuka do` without a live session does. `nuka do`, a
  live session, and `nuka explore` now run a step through one function.
- **A `{biginteger}` capture no longer aborts `nuka run`.** A typed step
  that bound a `{biginteger}` capture to `z.bigint()`, or a compat step with
  a `{biginteger}` capture, stopped the whole run with
  "Do not know how to serialize a BigInt", because JSON has no bigint and
  the step record was never written. A record now stores a bigint as its
  decimal string, in `args`, in `result`, and anywhere else, for `nuka run`,
  `nuka do`, a live session, and the Allure and messages emitters. `nuka
  harvest` compares a read-back line in that same form, so a
  `{biginteger}` line reads back instead of being named as a mismatch.
  `nuka do`, in a live
  session too, turns the stored string back into a bigint where the
  step's `args` schema expects one, for a value `--use` reads from a
  record and for `--args` JSON, which cannot spell a bigint either; a
  Date in `--args` is read back from its ISO string the same way. This
  follows the schema's input side, so a string piped into
  `z.coerce.bigint()` or a string codec still gets the string, and a
  string that an option of a union already accepts is left as it is.
  `docs/migration.md` no longer lists this as a compat difference.

- **`defineParameterType({ preferForRegexpMatch })` picks the type for a RegExp group.**
  The option never reached the parameter type registry, so a RegExp group
  that two types matched failed the step with "matches multiple parameter
  types". cucumber-js 13.2.0 converts it with the preferred type, and
  `nuka run` now does too. `config.parameterTypes` does not take the key.
  Two types that prefer one regexp, or a type that prefers a built-in
  type's regexp such as `{int}`'s, are a `parameter-type-invalid` error in
  `nuka check` that names the file, and a setup failure in `nuka run`.
- **A RegExp step's transformed group gets the World and the awaited value.**
  In a compat RegExp pattern, a group converted by a `defineParameterType`
  transformer ran that transformer with `this` set to `null`, and an async
  transformer's Promise reached the step unawaited. A `{color}` string
  pattern already got the World and the resolved value, as cucumber-js
  13.2.0 gives both. A RegExp group is now resolved the same way.
- **`nuka tend` reads a `from`-filled arg's description from its producer.**
  An args field that `from` fills was reported as undescribed unless the
  consumer repeated the producer's `.describe()`. A six-step CLI scenario
  that chained a directory, a path, and a commit through `from` got 16 such
  notes out of 29 fields. The field now counts as described when every
  producer it names describes that `returns` field, in the
  `schema-field-undescribed` note and in the `declared:` summary. An
  undescribed producer field still leaves the consumer's field reported.

- **Four Japanese spec cross-references name a heading that exists.**
  `docs/spec.ja.md` cited 「手入れ」, 「The state directory」, and
  「Keyword semantics」, which are not its headings. They now cite
  「Tending(手入れ)」, 「State directory」, and 「キーワードの意味論」.
- **The migration docs list what compat still does differently from cucumber-js.**
  The migration skill said that whatever will not work fails loudly, and told
  an agent not to look for a list. Some differences do not fail: the suite
  runs and computes something else. docs/migration.md "Known limits" now lists
  each one, measured by running the same glue under cucumber-js 13.2.0 and
  `nuka run`: `AfterStep` order, a RegExp group's custom transformer,
  `result.message`, the default step timeout, and `table.raw()`. It also lists
  two that fail where cucumber-js passes. The skill and the spec say that
  import failures are loud and point at that list.
- **Every Japanese file holds one sentence per line.**
  The rule that a Japanese file holds one sentence per line had no check, and
  90 lines in README.ja.md and docs/*.ja.md held two or more sentences. Each
  is now split after its 。, with no change of wording. A test now fails on a
  line with two or more 。 outside a fenced code block. A table row is
  exempt, because Markdown cannot continue a row on the next line.
- **Retention and `nuka tend` share one newest-run rule.**
  Each command had its own copy, and they disagreed on a scenario record whose
  `started_at` does not parse. Retention ranked a run with no parsable start as
  the newest, so with `retention.runs: 1` it removed the newest real run in its
  place. Both now read the record as unreadable, as `nuka tend` already did: it belongs to no run, and
  retention removes it by age.
- **A failed export write no longer leaves its temp file behind.**
  The Allure writer and the messages emitter write each file to a hidden
  `.<name>.tmp-<pid>-<random>` file and rename it into place. When the write or
  the rename failed, the temp file stayed in the results directory for good. It
  is now removed before the error is reported.
- **Retention removes an older run's messages stream after `messages.output` moved.**
  Retention found a run's `messages.<run_id>.ndjson` by the name the current
  `messages.output` gives it, so a run written before the setting changed kept
  its stream forever. A run now lists its stream in its own
  `records/runs/<run_id>/exports` when the stream is created, and retention
  removes it from there. A run written by an earlier version is still found by
  the current name.
- **An absolute `allure.resultsDir` or `messages.output` is used as given.**
  `nuka run` joined the configured path under the project root, so
  `/tmp/out/messages.ndjson` was written to `<root>/tmp/out/messages.ndjson`
  while the output line named `/tmp/out`. The path is now resolved against
  the project root, as `nuka clean` already did: a relative path stays
  root-relative, and an absolute path is used as it is written.
- **A messages run file removed mid-run is no longer published as a fragment.**
  When `nuka clean` removed a run's own `messages.<run_id>.ndjson` while the run
  was still going, the next write created the file again, starting at a later
  envelope with no `meta`, and the end of the run copied that fragment onto
  `messages.output`. Only the start of a run now creates the file. A later write
  to a removed file fails with a warning, and the configured path keeps the
  previous complete stream.
- **Allure's Examples and Data table CSV attachments quote their cells.**
  A cell that held a comma, a quote, or a line break was written as is, so the
  attachment split it into extra columns or rows. Such a cell is now quoted per
  RFC 4180, with each quote inside it doubled.
- **A scenario whose step returns nothing keeps its Allure result.**
  A step with `returns: z.void()` records an undefined `result`. The Allure
  emitter tried to attach it as `result`, failed, and dropped the whole
  scenario from allure-results with only a stderr warning. A step that returns
  no value now gets no `result` attachment, and its scenario is written as usual.
- **Two records no longer share one record directory when their ids collide.**
  A step or scenario record id has four random characters per second, so a run
  with many steps could draw the same id twice. The second record then reused
  the first one's directory and overwrote its `record.json` without a warning.
  The record directory is now created exclusively, and a taken id is drawn again.
- **Retention no longer removes a run that is still writing, or the run applying it.**
  With two `nuka run` processes overlapping, the one that ended first ranked the
  other as older and removed its records mid-run, and a run that ended after a
  newer one removed itself. A run now writes `records/runs/<run_id>/complete.json`
  (its verdict and end time) as its last act. Retention removes a run without that
  file only once its newest record is older than `retention.adHocDays`, and a run
  never removes itself. A run written by an earlier version has no file, so it is
  kept until it is that old.
- **`ctx.call` accepts concurrent calls and nests them correctly.**
  `await Promise.all([call(a, {}), call(b, {})])` failed with a false
  "does not list it in its own parts" error, because one global frame stack made
  `call(b)` look like a call from inside `a`. The current frame now follows the
  async call chain, so each call is checked against the step that made it.
  Concurrent calls appear as siblings in `calls`, in start order.
- **The clean-tree check sees untracked files whatever `status.showUntrackedFiles` says.**
  With `status.showUntrackedFiles=no` in git config, `git status` hid untracked
  files, so a tree with new files read as clean in the scenario record's
  `git.clean`. The call now passes `--untracked-files=normal`.
- **`ctx.request()` logs a call that throws, and logs the URL that was requested.**
  A call that threw (a refused connection, `failOnStatusCode` on a 500) wrote no
  http.jsonl line although `observed` counted it, and `url` was the string the
  step passed, so a relative path, `params`, and a redirect were not visible.
  The line is now written whatever the outcome. `url` is the response URL
  (absolute, params applied, redirects followed), as a page entry's is.
  `declared_url` keeps the passed string when it differs. With no response,
  `status` is `0` and `error` holds the first line of the failure message. A
  failed append on this path no longer throws into the step; it is counted in
  `http_log_failed`, like a page line.
- **A page http.jsonl line that could not be written is counted on the step record.**
  The append failed silently (a missing directory, a full disk, a permission
  error), so `observed` counted the request while http.jsonl, `http_omitted`,
  and `page_events` all said nothing. The step record now carries
  `http_log_failed`, the number of lines lost, only when it is above zero. The
  step still does not fail on it.
- **A step can `await import()` a TypeScript file from its body.**
  Discovery removed its TypeScript loader before any step ran, so
  `await import("./lib/helper.js")` of a `.ts` file failed with "Cannot find
  module", which read like a missing file. `nuka run` (including its worker
  processes), `nuka do`, and the live session now keep the loader until the
  command ends. `nuka check` and `nuka tend` run no steps and still remove it
  when discovery returns.
- **`nuka tend --json` no longer puts a fixture name in `step`.**
  The `fixture-unused` and `fixture-touches-app` notes carried the fixture
  name in `step`, so selecting `step == "login"` mixed a fixture finding with
  a step finding of the same name. They now carry it in a new `fixture` field
  and leave `step` unset, as `nuka check` does for its fixture findings. This
  changes the `--json` shape of those two notes; docs/upgrading.md says how.
- **The spec no longer says `browser` is read only for `headless`.**
  The whole `browser` object reaches the engine's `launch`, so `args`,
  `executablePath`, and `slowMo` take effect. `docs/spec.md` and
  `docs/spec.ja.md` now say it is passed unchanged.
- **The CLI summary in `docs/spec.md` lists every finding `nuka check` and `nuka tend` report.**
  The `nuka check` entry lacked the part, serial-tag, parameter-type,
  capture-syntax, table/docstring, env-file, explore, and other findings that
  `nuka check --codes` prints. The `nuka tend` entry lacked
  `post-navigation-read` and `repeated-scenario-prefix`. Both entries now cover them, in the
  English and the Japanese spec.
- **The acceptance skill matches what `nuka check` and `nuka tend` print.**
  `writing-steps.md` said a line with a missing quote is reported as
  `undefined-step` "rather than naming the missing quotes", but check adds a
  hint with the rewritten line when exactly one pattern fits.
- **`nuka check` reports `capture-type-mismatch` for every capture that always fails args validation.**
  It used to compare only `{int}`/`{float}` with a string field and
  `{string}`/`{word}` with a number field. `{double}`, `{long}`, `{short}`, and
  `{byte}` against a string, `{word}` or `{int}` against a boolean, the
  anonymous `{key:}` against a number, and `{int}` against
  `z.string().transform(...)` all passed check and failed at run. check now maps
  each built-in capture to its JS type and compares it with the field's
  primitive, reading a pipe through its input side. A coerce, a union,
  `z.any()`, a preprocess, and a custom parameter type stay silent.
- **A table or docstring on a key of the wrong type is caught by `nuka check`.**
  A table is passed as `string[][]` and a docstring as a string. A table on
  a `z.string()` key, or a docstring on an array, number, boolean, or object
  key, passed `nuka check` and failed args validation at run. Check now
  reports it as `table-docstring-key-mismatch`. An array key with a table, a
  coercing schema, a pipe, a transform, and a union stay silent.
- **An `oaths` directory with no Markdown file is now reported.**
  `nuka check` stayed green when a named oath directory held no `.md`
  file (an empty directory, or files named `.MD`), while a missing path
  was `feature-parse-error`. It now reports `feature-parse-error` and
  says that only `.md` files are read. `nuka run` on such a directory
  said no `.feature` file was found; it now says no Markdown file was
  found.
- **A live session no longer drops a failed fixture teardown or a failed version probe.**
  `nuka session stop` discarded every teardown error, so it printed nothing
  and exited 0, while `nuka do` and `nuka run` warn. A failed environment
  `version` probe was dropped the same way. Stop now prints one `Warning:
  fixture "<name>" teardown failed` line per fixture, redacted, and still
  exits 0. Each `nuka do --session` prints the `nuka do` version probe
  warning. The wording now comes from one shared helper.
- **`tracked-secret-looking-key` no longer fires on a name that only contains the letters KEY.**
  The heuristic matched `_KEY` inside longer words, so `SEARCH_KEYWORD`,
  `MAX_KEYS_PER_PAGE`, and `DEFAULT_KEYBOARD_LAYOUT` got a warning. `KEY` now
  counts only as a whole underscore-delimited token (`KEY`, `API_KEY`,
  `KEY_ID`, `PUBLIC_KEY_URL`), as the code comment always said. `APIKEY` does
  not match. The secrets paragraph of `docs/spec.md` and `docs/spec.ja.md` now
  lists what `nuka check` prints (two warnings) and what `nuka tend` prints
  (the two unknown-key notes).
- **Three `nuka tend` messages now say what the code does.**
  `from-unused` said a `from` key could be filled by a capture or a
  table/docstring, but only a capture fills it. `pattern-unbound` said no
  line under `featuresDir` binds the step, but tend also scans
  `additionalFeatureDirs` and oaths, so it now says "the scanned
  directories". `import-failures-unseen` printed "1 step file ... are
  missing"; the verb now agrees with the count.
- **A line held up by a pattern that does not build is not called an undefined step.**
  A pattern that names an unregistered parameter type is reported once as
  `unknown-parameter-type`. Each line that pattern would have matched was
  also reported as `undefined-step`, with advice to scaffold a step that
  already exists. Such a line is now an `undefined-step-check-suppressed`
  warning that names the step. A line no step could match is still
  `undefined-step`.
- **`nuka tend` is faster on a project with many typed steps.**
  Tend matched every pickle step against every pattern, while `nuka check`
  already reused one result per distinct step text. Tend now uses the same
  per-text match. On 400 typed steps and 4000 scenarios of 5 lines, `nuka
  tend` went from 7.2s to 4.4s. Its output is unchanged.
- **`schema-field-undescribed` sees a description under any wrapper.**
  A field written `z.string().describe("x").nullable()` was reported as
  undescribed, and the `describe` count in the `nuka tend` summary was too
  low. Only `optional` and `default` were unwrapped. The check now also
  looks inside `nullable`, `nullish`, `readonly`, `catch`, `prefault`, and
  the input side of `.transform()` and `.pipe()`.
- **Concurrent first `ctx.page()` or `ctx.request()` calls share one launch.**
  Two calls made together, as in `Promise.all([this.openPage(), this.openPage()])`
  in compat glue, each saw no browser yet and launched their own. The second
  handle replaced the first, and nothing closed the first. The calls now wait
  on one in-flight launch and get the same object. A launch that fails is not
  kept: the next call tries again.
- **The Markdown oath parser reads an indented or tilde fence as narration, and keeps a heading's trailing `#`.**
  Only a backtick fence at column 0 opened a code block, so a fence inside
  a list item or a `~~~` fence turned every code line into a step. A fence
  now opens with three or more backticks or tildes at any indentation. It
  closes on a line of the same character, at least as long, with nothing
  after it. `## Learn C#` now names the scenario "Learn C#". A closing `#`
  sequence is stripped only after whitespace.
- **The `nuka check` escape hint sees a parameter type registered in compat code.**
  The hint that names a pattern whose bare `( )` or `/` keeps it from
  matching was built only from `config.parameterTypes`. A pattern that
  used a type from a compat `defineParameterType` got a plain
  `undefined-step` with no hint. The hint now uses the same registry as
  matching.
- **`nuka check` reports a finding on a Background or outline line once.**
  A Background line reaches the check once per scenario, and an outline
  line once per Examples row. Every finding about such a line except
  `undefined-step` repeated that many times, in the text output and in
  `--json`. A finding with the same code, file, line, step, and message is
  now reported once.
- `nuka harvest` refuses a repeated step record id before it prints a draft.
  The refusal names the repeated id once. One execution cannot become multiple steps.
- **Feature walks skip `node_modules` and dot-directories.**
  `walkFeatureFiles` entered both, so `featuresDir: "."` and `nuka run .`
  checked and ran `.feature` files from dependencies and from `.nukadoko`.
  The walk now skips `node_modules` and any directory whose name starts
  with `.` at every depth, the same directories step discovery skips. The
  skip reports nothing.
- **`nuka run`, `nuka do`, and `nuka harvest` name the step file that threw while being imported.**
  The message was Node's own text alone, so a project with many step files
  gave no way to tell which one threw. The file's path, relative to the
  project root, is now the start of that same message. `nuka check` and
  `nuka steps` already named the file.
- **A config that fails to import names the file and the cause.**
  The raw loader error did not say which config file failed. A syntax
  error in `nukadoko.config.mts` was reported against a `.ts` path. A
  CommonJS project's `nukadoko.config.ts` now also gets the same rename
  hint a `.ts` step file already gets.
- **`nuka check` reports done-callback compat glue.**
  A hook whose function declares more parameters than nukadoko passes, and
  a matched compat step whose function declares more parameters than the
  line's captures plus a table or docstring, used to pass `nuka check` and
  fail `nuka run`. The finding is `done-callback-arity`. A `"pending"` or
  `"skipped"` return is still only visible when the function runs.
- **A hook's `name` is metadata.** `Before({ name })`, `After({ name })`,
  `BeforeAll({ name })`, and `AfterAll({ name })` used to throw at
  registration, so the step file failed to import. The string is stored
  and used as the hook's title. `on` is still rejected. `AfterStep` still
  rejects `name`.
- **A compat World can receive `this.parameters`.**
  The constructor always received `{}`, so glue that read
  `this.parameters` (a cucumber.js profile's `worldParameters`, or
  `--world-parameters`) saw `undefined` until the value was used.
  Set the object on `worldParameters` in `nukadoko.config.ts`.
  The default is still `{}`. There is no command line flag for it.
- **`nuka session clear --env <typo>` and `nuka session stop <typo>` no longer succeed silently.**
  `session clear --env` of an environment the config does not define exits 1 and names it, unless session files are still left under that name.
  Those files are still cleared, the command exits 0, and stderr names the environment.
  `session stop` of a name that was never a session still exits 0, and stderr names the session and the environment.
- **A repeated singular flag is refused by name.**
  yargs collects a repeated string or number flag into an array.
  `nuka init --base-url http://a --base-url http://b` wrote that array
  into `baseURL` and left the generated files on disk. `--env a --env b`
  became the environment name `a,b`, and `--concurrency 2 --concurrency 3`
  became the value `2,3`. The parse now refuses the flag and writes
  nothing. `--use` and `--fail-on` stay repeatable.
- **`nuka session start --idle-timeout` refuses a delay the session cannot keep.**
  `abc`, `0`, a negative, and a value above 2147483 seconds used to start a
  session that stopped itself at once. Node clamps each of those timer
  delays to 1 ms. The command now refuses them before a process starts, and
  names the flag and the range.
- **An env file is read the way dotenv reads comments, quotes, escapes, and values that span lines.**
  A trailing `#` was part of the value. Quotes stayed in the value when a
  comment followed them. `\n` inside double quotes stayed as two characters.
  A quoted value that spanned lines was split, so a line inside it could
  become its own key, and a secret written that way was neither in `ctx.env`
  nor in the secret set. The separator is `=`. `nuka check` warns with
  `env-file-skipped-line` for a line that was not loaded. The finding names
  the file and the line, not the text. What an existing project has to
  change is in docs/upgrading.md.
- **A Date or URL in a step result is recorded as its JSON form.**
  `redact` walked every object with `Object.entries`. A Date and a URL
  have no enumerable properties, so the step record and the Allure
  attachment stored `{}`. `redact` now redacts whatever
  `toJSON()` returns, and still replaces a loaded secret in that text,
  including the percent-encoded spelling and the JSON-escaped spelling.
  A JSON number equal to a numeric secret stays a number.
- **Repeated config loads in one process stay at the cost of one load.**
  `loadConfig` went through tsx's `tsImport` on every call, and each call
  left a loader on the chain. `recordStep` loads the config once per step,
  so a long run got slower as it went. The parsed config is reused for the
  same project root while the config file keeps its name, mtime, and size,
  so a process that outlives an edit to the config still reads the edit.
- **A throwing compat World constructor fails that scenario.**
  The throw used to escape `nuka run` as a stack, so later scenarios never
  ran and the messages export was left unfinished. The scenario is now
  failed, stderr gets one setup line, the rest of the run continues, and
  the export is finalized.
- **`nuka check` names a broken config fixture, in fixture wording.**
  A `config.fixtures` function with a default value, a rest property, a
  bare parameter, or an unknown dependency was reported as a step's
  `run()`, and a default value was quoted after the transform had rewritten
  it (`undefined` became `void 0`). The finding now names the fixture and
  does not quote that rewritten text. A valid config fixture is unchanged.
- **An unreadable env file, or a directory named like one, is refused.**
  Both used to be treated as a missing file: `ctx.env` came back empty
  and the first `requireEnv` blamed the key. A path that is not on disk
  still contributes nothing. The refusal names the configured path and
  the errno. `ctx.env` and the secret set share one read.
- **A compat hook receives the fields cucumber-js passes.**
  `AfterStep` now gets `pickleStep` and `testStepId`. `After` and
  `AfterStep` get `result.duration`, and, when the step or scenario
  failed, `result.message` and `error`. A hook that logs
  `pickleStep.text` or `result.message` reads the step text and the
  failure text.
- **A step that writes to stdout no longer breaks `nuka do` or `nuka run`.**
  `console.log` and `process.stdout.write` from a typed step or a compat
  step are delivered on stderr while the step runs. `nuka do` stdout stays
  one JSON step record. `nuka run` stdout stays NDJSON, including the
  envelope stream a worker writes under `--concurrency`.
- **`nuka clean` refuses an export path that would delete the project or leave it.**
  `allure.resultsDir` or `messages.output` set to the project root, to a
  path outside the project, or to a parent of the state directory makes
  the command exit 1 and remove nothing, including on `--dry-run`. A
  results directory inside the project is still removed, unless that
  directory is a parent of the state directory.
- **`nuka describe` does not list a defaulted args key as required.**
  Args JSON Schema is the input a caller must supply, rendered from the
  same strict schema execution parses. A key with `.default(...)` is
  absent from `required`. A key without a default stays required.
  `returns` stays the output schema, where a defaulted key remains
  required because the value the step produced always includes it.
- **A throw from a command handler prints one stderr line.** The handler's
  message was already written and the exit code already set to 1, and the
  same rejection then left the process entry, so Node appended its
  uncaught-exception dump. That rejection is now caught after the report.
- **`nuka describe` reports a schema JSON Schema cannot represent.**
  When `args` or `returns` cannot be turned into JSON Schema, the command
  still prints the rest of the contract. That side is null, and
  `args_error` or `returns_error` names the step and why. The command
  exits 1. A schema that can be represented is unchanged.
- **A negative compat timeout means no timeout.** `setDefaultTimeout(-1)`
  and a step or hook `{ timeout: -1 }` failed every compat step at once,
  with "timed out after -1ms". cucumber-js arms a timer only when the value
  is zero or greater, and a negative value is how a suite turns the limit
  off. A positive timeout still applies. Zero still times out. A typed
  step's own timeout is unchanged.
- **A World subclass can assign `this.page` and `this.request`.**
  Both were getter-only, so the usual cucumber-js assignment threw in
  strict mode. The setter stores that value, and the getter returns it
  ahead of the page `openPage()` or `openRequest()` stored. The
  assignment stays unmeasured.
- **A config file with no default export, or a Promise as its default, is refused.**
  Both used to be read as `{}`, so `featuresDir`, `secrets.redact`, and
  every other key in the file were ignored. The error names the file. An
  object default, including `export default defineConfig({ ... })`, still
  loads.
- **`defineWorld` refuses `page` and `request`.** Declaring either used to
  pass `nuka check` and crash `nuka run` with `WorldNotOpenedError`, which
  blamed a missing `openPage()` or `openRequest()`. The import now fails.
  `nuka check` reports `step-file-import-failed`, and `nuka run` stops with
  the same message, which names the field. Assigning `this.page` or
  `this.request` on a World subclass is unchanged.
- **`connectMcpServer` stops the server it spawned when the handshake fails.**
  The rejection used to return while the child was still running, because
  the caller never received a client to close. The error names the command.
  A successful handshake still returns a live client for the caller to close.
- **`nuka check` does not report `capture-type-mismatch` for a schema that coerces.**
  A `{string}` bound to `z.coerce.number()`, and an `{int}` bound to
  `z.coerce.string()`, parse when the scenario runs. check used to exit 1
  on that project. A field that does not coerce is still a mismatch.
- **`defineStep` refuses a malformed definition when it is declared.**
  A step file that omitted `args` or `run` aborted `nuka check` with a
  TypeError that named no file. A `timeout` of `Infinity`, `0`, a negative
  number, `NaN`, or anything above 2147483647 was stored, and Node's timer
  clamped it to 1ms, so the step failed as a timeout. `defineStep` now
  throws `InvalidStepDefinitionError` for those shapes. `nuka check`
  reports the throw as `step-file-import-failed`. A valid step is unchanged.
- **Writes through `page.request` and `context.request` are measured.**
  A step that calls `page.request.delete` or `context.request.post` used to
  leave `observed.http_writes` at 0 and write no http.jsonl line, so a wrong
  `mutates: false` could not be checked against what ran. Those calls are
  now logged the same way as the `request` fixture (`via: "request"`). GET
  and HEAD stay reads. In-page `fetch` and navigation stay `via: "page"`.
- **`ctx.env` is a frozen copy, not the shared map.** A write in one step
  stayed visible to a later step and a later scenario, because every
  scenario received the same object. Assigning a property now throws, and
  a configured key still reads back as the loaded value.
- **A fixture whose setup times out still tears down if setup finishes late.**
  The scenario still fails, and the report still names the fixture and the
  phase. When the fixture then calls `use()`, that call resolves as
  `"failed"` and the teardown after it runs. A failure in that teardown is
  written to stderr.
- **A percent-encoded or JSON-escaped secret stayed in the record.**
  Redaction matched only the loaded text, so a query string that had
  already been percent-encoded, or a string that already held JSON,
  kept the secret. Both forms are now replaced with the same
  `{{secret.NAME}}` token. A JSON number equal to a numeric secret is
  left as a number, because matching it would rewrite ordinary counts
  and change the field's type. The digits are still removed where they
  appear as text.
- **SIGINT and SIGTERM during `nuka run` or `nuka do` still tear fixtures down.**
  The process used to take the default action and exit before any fixture
  teardown. The first signal tears down scenario scope, disposes the
  context, tears down process scope, and exits with 128 plus the signal
  number. `use()` receives `"failed"`. A second signal exits at once.
  A normal finish is unchanged.
- **Redaction leaves a token intact when a secret occurs inside it.**
  Replacing one secret wrote `{{secret.NAME}}`, and a later secret whose
  value was a piece of that token (`secret`, `TOKEN`, `API_`) rewrote it.
  A second redact nested the token again. Spellings are replaced in one
  pass, longest first, and an existing token is kept as itself.
- **`ctx.poll`'s `timeout` is a budget for the whole call.** An attempt
  that is still running when the budget ends times out, and a value that
  arrives later is not returned. A `fn` that never settles times out with
  the budget instead of holding the step open. `timeout` and `interval`
  must be finite and greater than zero. `NaN`, `Infinity`, zero, and a
  negative number throw `InvalidPollOptionsError` before the first attempt,
  instead of polling without end. Omitting either option still uses its
  default (30 seconds, 500 milliseconds).
- **A page request's http.jsonl line stays on the step that sent it.**
  The line was written when the response arrived, so a click that returned
  before its POST finished left the POST on the next step. `observed` had
  already counted the write on the step that sent it. The log path is now
  taken when the request starts.
- **`nuka check` names a bad feature argument for what it is.**
  A directory and an unreadable file used to print "feature file not
  found". It now tells you to pass a `.feature` or `.md` file,
  or to use `nuka run` for a directory, when the path is a directory. Any
  other read error keeps its own text. A path that is not there still
  reports a missing file.
- **`nuka describe` and `nuka do` name a missing features directory.**
  A project whose `featuresDir` is not on disk used to get `Unknown step`
  from both, the same misdiagnosis `nuka steps` already refuses. They now
  name the configured directory and the path they resolved, and still
  exit 1. A directory that exists and simply has no such step is
  unchanged.
- **The spec's "Records" section describes `session_execution` and the scenario record's `git`.**
  Both fields were written to records but defined nowhere in the spec. It now
  says that `session_execution` is an execution's 1-based position in a live
  session and is absent otherwise, and that `git` holds the commit and the
  cleanliness of the working tree when the run started. The Japanese spec
  matches.
- **`recordStep` names the real cause when a `use` id cannot be matched.**
  A `use` id recorded by `nuka do`, or by another process, names a step this
  process never ran through `recordStep`, so `recordStep` has no name for
  that `from` upstream. The refusal said the record's step was "not named by
  any of this step's `from` entries", which sent the reader to the `from`
  declaration. It now says the upstream has no name here and that `use`
  resolves only against a step recorded earlier in the same process.
- **The `recordStep` docs state its four limits.**
  The spec, the Playwright Test migration guide, and the migration skill did
  not say that `use` resolves only against a step the same process recorded
  through `recordStep`, that a `config.fixtures` entry is always refused, that
  no environment is selected and no read-only policy is enforced, or that no
  version probe runs. They now say all four. The Japanese files match.
- **The spec's CLI summary names every command and flag the CLI has.**
  It listed `nuka session list|clear` only, and left out `session start` and
  `session stop`, `check --codes` and `check --json`,
  `session list --json`, `session clear --env`, and `--env` and `--session`
  on `run` and `do`. It now lists them, with `--idle-timeout` and its default
  of 900 seconds. The acceptance skill names that default too. The Japanese
  spec matches.
- **The spec names fixtures, not `ctx` members, for typed steps.**
  Ten passages wrote `ctx.page()`, `ctx.request()`, `ctx.requireEnv`,
  `ctx.poll`, `ctx.section`, or `ctx.env`, although a typed step reaches each
  through its fixture bag. They now name the `page`, `request`,
  `requireEnv`, `poll`, `section`, and `env` fixtures, in the English and the
  Japanese spec and in the acceptance skill's maintenance reference.
- **`llms.txt` names the real commands.**
  It said `nuka skill` prints the skills directory (the command is `nuka skill
  path`) and described `nuka mcp-tools` as nukadoko's own tool list. The
  command lists the tools another MCP server declares over stdio, given after
  `--`. Both lines now say so.
- **Pointers to a missing spec heading now name "Compat steps (the migration door)".**
  Three CLI messages (the `nuka steps` compat entry, `nuka do`, and the live
  session) and two spec passages sent the reader to "What compat steps lack",
  a heading that no longer exists. They now cite the section that covers it,
  in the English and the Japanese spec.
- **The README and migration guide match the CLI on four points.**
  The README said no multi-attempt run ships (`nuka run --repeat` does that),
  explained the caret only for `0.0.x` (for `0.y.z` it pins the minor), said
  every non-GET call counts as a write (HEAD is a read, as in the step
  record), and said `nuka init` writes only `.nukadoko/` to `.gitignore` (it
  also writes `.env`, `.env.*`, and `!.env.example`). The migration guide had
  the same init claim. The Japanese files match.
- **The spec no longer claims shell completion, a silent unescaped `(`, or a daemon-free `session`.**
  It said typed step names and ids complete in the shell (the CLI has no
  completion), said `nuka check` passes a pattern with a bare `(` (it reports
  the feature line that would match if escaped, with a hint), said sessions
  use no daemon (`nuka session start` starts one). Each
  statement now matches the CLI, in the English and the Japanese spec.
- **The upgrading guide names the release that carried the 0.12.0 changes.**
  The heading "0.12.0 to the next release" stayed after 0.13.0 shipped those
  changes, so it read as still pending. It is now "0.12.0 to 0.13.0", in both
  languages. `docs/releasing.md` now has a step that renames the open
  "to the next release" heading to the version being released.
- **Four contributor and translation docs are corrected.**
  `CONTRIBUTING.md` said two tests name `firefox` in a config; five do.
  `docs/ci.ja.md` cited the spec heading "Sessions, environments, secrets",
  which the Japanese spec calls "Session、environment、secret".
  `README.ja.md` linked the English spec for step chaining and now links
  `docs/spec.ja.md`. The glossary's note and heading rules now cover every
  paired Japanese file, including the Playwright Test migration page.
- **Two comments in `src/record/types.ts` match the code and the spec.**
  The `timeout` error kind said only a compat step's own timeout produces it,
  but a typed step's `stepTimeout` deadline produces it too. The `observed`
  comment said run-time keyword enforcement and read-only environments act on
  the count, but they act on the declared `mutates`; the count is a measured
  fact beside it. Both comments now say that.

### Breaking

- **BREAKING: `nuka accept` and every sign-off finding are removed; the run summary replaces them.**
  No project kept the `*.feature.*.md` records `nuka accept` wrote, and
  the command required a clean tree, a run at HEAD, a whole-feature run,
  no sharding, a hand-written PR check, and a weekly tend job. Approving a
  pull request beside the run summary `nuka run` writes makes the same
  claim, bound to the commit by the forge. Removed: the `accept` command
  (`nuka accept <feature>` now fails as an unknown argument) and the
  `nuka tend` codes `feature-never-signed`, `signed-feature-unscanned`,
  `signoff-condition-mismatch`, `signoff-feature-changed`,
  `signoff-feature-missing`, `signoff-record-old-format`,
  `signoff-record-unreadable`, `signoff-result-invalid`, and
  `signoff-step-missing`. `nuka tend --fail-on` with one of those codes
  exits 1 before analyzing and names the run summary as the replacement.
  `nuka tend` no longer reads `*.feature.*.md` files, so old records are
  inert; every tend finding is now a note, so `nuka tend` exits 0 unless
  `--fail-on` fires, and `--json` keeps `errors` as an empty array. A
  `nuka run <feature>:<line>` notice now says the run summary covers only
  the selected scenarios instead of saying the run cannot be accepted.
  README, the spec ("Sign-off" becomes "Review"), the CI guide, the skills,
  `llms.txt`, and the package description now describe the run summary a
  pull request carries instead of sign-off. docs/upgrading.md says what to
  change.

- **`ctx.evidence.attach` and `ctx.evidence.path` no longer replace a harness file.**
  A name of `record.json`, `final.png`, `trace.zip`, or `http.jsonl` is
  refused with `ReservedEvidenceNameError`, including a spelling that
  differs only by case. Those files are what the harness writes in the
  same directory, and a step name that landed on one of them replaced it.
  Two other names that differ only by case are kept as two files, the same
  way two identical names already were: the second gets `-2` before the
  extension. A step that attached a harness file name has to pick a
  different one. See docs/upgrading.md.
- **The Allure and messages emitters are off until their config key is present.**
  `nuka run` wrote Allure results and two messages NDJSON files on every
  run, twelve files for one two-step scenario, and every early adopter
  deleted the Allure files `nuka init` wrote. `allure: {}` or `messages: {}` in `nukadoko.config.ts` now turns
  each on; `allure.resultsDir` and `messages.output` keep their meaning
  inside it, so a project that already set either changes nothing. The
  output-location lines on stderr name only an emitter that is on.
  Retention and `nuka clean --export` still remove what earlier runs wrote.
  See docs/upgrading.md.
- **`nuka init` sets up a CLI or API project and wires it into package.json.**
  It writes `nukadoko.config.ts` with one comment line, `features/steps/`,
  and `.nukadoko/` in `.gitignore`, then adds
  `"test:scenarios": "nuka check && nuka run features"` (the
  `--features-dir` value in place of `features`) to `package.json` scripts
  unless a script of that name exists, keeping the file's indentation.
  With no `package.json`, stderr says no script was added. When
  `tsconfig.json` has an `include` that leaves out the steps directory or
  the config file, one stderr line names the entries to add; a tsconfig
  with no `include` of its own, or one that does not parse, gets no line.
  `--allure` writes `allurerc.mjs`, creates the results directory, and puts
  `allure: {}` in the config; without it none of the three happen. `--env`
  adds `.env`, `.env.*`, and `!.env.example` to `.gitignore`, which used to
  happen every time. stdout still lists only the paths written.

## 0.14.1 — 2026-10-10

### Fixed

- **`nuka check` reports an outline whose boundary rows will not run.**
  A Scenario Outline or Scenario Template with no Examples table runs once
  with the placeholder text left in. An Examples table with a header and no
  body row produces no scenario at all. Both were silent.
  `outline-does-not-run` names the scenario and the line. A table with at
  least one row is unchanged. nukadoko does not generate the rows and does
  not run a property test.

## 0.14.0 — 2026-09-30

### Added

- **Markdown oaths are a second front beside Gherkin.**
  `oaths` in `nukadoko.config.ts` names Markdown files, or a directory of
  them, that compile into the same scenarios, bind the same typed steps,
  and show up in `nuka check` and `nuka run` with step records. A sentence
  no pattern matches is `undefined-step`. The default is `[]`. An explicit
  `.md` path is an oath even when it is not listed.
  `examples/todo/features/todo.md` is the worked example. What this slice
  reads, and what it leaves, is in docs/spec.md ("Markdown oaths").
- **`StepRecordBase` is exported.** `StepRecordOk` and `StepRecordFailed`
  both extend it, and it holds the fields every step record carries, but
  the type itself had no public name. Code that handles either kind of
  record can now name the shared part directly.

### Changed

- **`nuka check` matches each step line once instead of three times.**
  The undefined/ambiguous check, the `from` order check, and the
  unfillable-key check each scanned every pattern for the same line. They
  now share one result per distinct line text. On 1000 typed steps and
  10000 five-line scenarios, `nuka check` went from 10.0s to 5.6s. The
  findings are unchanged.

## 0.13.1 — 2026-09-23

### Fixed

- **A refused live-session request's idle-timer re-arm is checked on one clock.**
  The assertion slept in the test process, then checked that the daemon
  process was still alive. The daemon arms its timer when it finishes the
  refused request, before `nuka do` returns, and under CI load that gap
  exceeded the slack in a 1s timeout. The publish for `v0.13.0` failed the
  alive check after the refusal itself had succeeded. The assertion now
  runs the session core in-process and advances a fake clock, so the
  re-armed window and the timeout after it are both exact.

## 0.13.0 — 2026-09-23

### Changed

- **The acceptance and migration skills now open as short routes.**
  Each `SKILL.md` says when to use it, what not to do, and which file
  under `references/` holds the procedure for the step you are on.
  The prose-to-requirements stage moved to
  `skills/acceptance/references/from-prose.md`. The three migration
  starting points moved to `skills/migration/references/`. The commands
  are unchanged.

### Breaking

- **A typed step's own `run` now has a deadline: twenty minutes by
  default.** A step that never returns used to take the whole run with it.
  A project's CI hit its job limit six times in a row, about two and a half
  hours of runner time, because one step waited on a Playwright mouse call
  that carries no timeout of its own: 106 of 107 scenarios finished and the
  run never reached its summary. The step is now failed with
  `error.kind: "timeout"`, and the run continues to the next scenario and
  reaches its summary, naming which step ran out of time.

  `stepTimeout` in `nukadoko.config.ts` sets the limit for the project and
  `defineStep({ timeout })` overrides it for one step. There is no value
  meaning "no limit". The default is not a guess about step durations: it is
  the horizon this tool already had, 120 Allure heartbeat ticks of ten
  seconds, so one run has one horizon rather than two. It sits far above
  what steps take in practice, measured at a median of 66ms and a maximum of
  14s across 800 step records sampled from a real browser suite, with none
  over 30 seconds. A project with a legitimately longer step raises the
  number; `docs/upgrading.md` says how.

  Compat steps are deliberately not covered and still run unbounded unless
  their own glue declares `{ timeout }` or calls `setDefaultTimeout`, which
  is what keeps a migrating suite's slow step from failing purely from
  switching.

### Added

- **`src/index.ts` now exports 22 internal types by name.** `StepRecordOk.observed`
  held an `ObservedCounts` value, but a consumer could not import `ObservedCounts`
  from `nukadoko` to write a function parameter type over that field. Found by
  walking every type `index.ts` exports and listing each declaration it reached
  that `index.ts` itself did not export by name. No type's shape changed.

- **A `--concurrency <n>` run says which scenario a worker is running, not
  only which one finished.** The parent hears from a worker when a scenario
  ends, so the line naming a scenario used to arrive after it was over, and
  a hung scenario left a log whose last line named the one before it. A
  worker now announces each pickle as it begins, and the parent writes one
  line naming the worker, the feature and line, and the scenario. It carries
  no index, since the finishing line's number means "the Nth to finish" and
  one number should not mean two things in one log. `--quiet` suppresses
  both. A serial run is unchanged, its boundary line having always been
  written at the start. Reported by a project that recovered a hung
  scenario's name six times by diffing its CI log against a local run.

- **The acceptance skill's maintenance reference says not to delete an old
  record before re-taking one.** A record's name carries the commit it
  froze, so a fresh `nuka accept` writes a new file beside the old one.
  Deleting first makes the tree dirty and `accept` refuses: it sets an
  existing record aside when it checks for a dirty tree, but a deleted one
  cannot be read and so cannot be recognised as a record. Reported by a
  project whose `rm -f features/*.md` was refused, correctly, and then
  committed by the next command in the same `&&` chain.

## 0.12.0 — 2026-09-04

### Breaking

- **The acceptance record's name now starts with the whole feature file
  name, extension included:** `launcher.feature.2026-09-03-42a4e15.default.no-browser.md`
  rather than `launcher.2026-09-03-...`. A listing shows the record right
  after its feature; the old name sorted before it, since a digit sorts
  before `f`, and two records put two lines between a feature and its
  neighbour. Nothing reads a record by its name (tend and accept find
  records by frontmatter), so records already written keep working, and a
  glob on `<basename>.*.md` matches both forms. Reported from a suite
  reading its features directory by eye.

### Added

- **`nuka run --repeat <n>` runs every selected scenario `n` times in one
  invocation.** The whole selection runs once, then again, so a failure
  that depends on what ran before it meets the same neighbours on every
  pass. Each execution is its own scenario record under the one run_id,
  the summary counts executions, and a scenario that failed at least once
  gets a `repeat` line after the failed list, `<passed> of <n> passed`,
  with no verdict attached. Under `--concurrency`, each worker repeats its
  own files; a target naming one file still runs at 1. Asked for by a
  project that had chased a failure reproducing one time in three with
  shell loops of 12 and 14 `nuka run` invocations, which spread the
  evidence over that many run ids.

- **`nuka run` says before running when a step's pattern could not be
  built.** A pattern with an unnamed capture (`{state}` with no `:type`)
  or an unregistered parameter type matches nothing, so its line used to
  report as undefined with the same red an assertion failure gets, and
  nothing said which. The run now prints one warning per such step before
  the first scenario, naming the step, the pattern, the reason, and the
  `nuka check` code that reports it. A warning rather than a refusal: the
  broken step may be one no selected scenario uses.

- **`nuka accept` after a `--repeat` run embeds each scenario once, the
  last execution, and says the count.** Every execution in the accepted
  run was green (accept required that already); the record's Condition
  section gains `- repeat: each scenario ran n times in this run`, since
  green three times is a different claim from green once, and a reader
  gets the count without the other copies. `nuka tend`'s
  `repeated-scenario-prefix` counts a scenario once however many times it
  ran, rather than reading the repetition as a shared opening between "n
  scenarios" that are the same one.

- **`nuka tend --fail-on <code>` turns one note into a red exit for that
  invocation.** Repeatable or comma-separated. The finding stays a note in
  the output; only the exit code changes, and stderr says which code fired
  and how often. A code `tend` never reports is refused up front. This is
  what lets a PR job gate on `feature-never-signed` while `tend` stays
  non-blocking everywhere else, which a review of how a team would run the
  acceptance loop under deadline pressure found missing: the only way to
  notice an unsigned feature was a weekly note nobody had to read.

- **The acceptance record's Condition section states how many steps
  declared `mutates: false` and were measured making writes.** The list
  stays in the closing "Declared vs observed" section, since it is computed
  from the detail above it; the count is now up front, because a reviewer
  of a record with several scenarios may never reach the end, and the
  count is what says whether to.

- **The `repeated-scenario-prefix` note names where a lift goes.** It now
  ends by saying that the place to lift a shared opening into is a
  `"process"`-scope fixture, and that whether the scenarios can share what
  it builds depends on which of them write to that state, which the tool
  cannot see. The spec already said so; the note reaches a reader who
  never opens the spec.

### Fixed

- **A step can take one args key from `from` and the other from a table or
  docstring on the same line.** `nuka check` and `nuka run` counted the
  key a table or docstring fills among the keys a named capture had not
  consumed, and never subtracted the keys `from` declares, so a step with
  one key chained from an earlier step and one required docstring key was
  refused with `table-docstring-key-mismatch` ("2 args keys are left
  unconsumed") on both sides. Both now treat a `from` key as spoken for,
  the same way a captured key is, in the one binding rule check and run
  share; `from-unused` and `unfillable-required-key` read the same rule.
  Reported by a suite that had worked around it by making the chained key
  optional, which weakened the from-order check for that step.

## 0.11.0 — 2026-09-02

### Breaking

- **`nuka run` keeps the newest `retention.runs` runs (default 20) and
  removes every older one at the end of each run.** A run is every
  scenario record sharing one `run_id`, dated by its earliest `started_at`,
  the same rule `nuka accept` and `nuka tend` use to name the newest run.
  An older run loses its scenario records, the step records they cite, the
  export files listed in its own `.nukadoko/records/runs/<run_id>/exports`,
  and its messages stream. A record no retained run owns (a `nuka do` or
  `recordStep` record, a record whose run is gone, an unreadable scenario
  directory, a run that stopped before its first scenario finished) is
  removed once older than `retention.adHocDays` (default 7). Neither number
  has an "off" value. Retention is skipped, and says so, while a live
  session is up. The line it prints goes out under `--quiet` too.

  The measurement behind it: one project ran 202 times in four days and
  left 70,229 step records and a 19 GB state directory, with `nuka tend`
  taking 20 seconds to walk it, and nobody had noticed. The defaults are a
  judgment: at about 50 MB per run for that suite once attachments are
  hard links, 20 runs is about 1 GB, and fewer would lose the failure a
  person was chasing an hour ago on a suite run every few minutes.

  What this changes for a project already on nukadoko, including the
  one-time `nuka clean --export` for a results directory written before
  runs kept a manifest, is in `docs/upgrading.md`.

### Added

- **Each run records which export files it wrote**, under
  `.nukadoko/records/runs/<run_id>/exports`, one root-relative path per
  line, appended by whichever process wrote the file. This is what lets a
  run's Allure output leave with the run: an attachment's name is chosen by
  allure-js-commons and written into the result before the writer sees it,
  so a run cannot stamp its id into the name, and the parent of a
  `--concurrency` run never holds the names its workers chose.
  `nuka clean --records` removes these directories with the other records.

- **`nuka do --use`, `nuka harvest`, a live session's `do`, and
  `recordStep` say that a missing step record may have aged out**, naming
  the retention policy in force, rather than only "no such step record".

### Fixed

- **A trace zip or screenshot was stored twice, once under
  `records/steps/<id>/` and once as its Allure attachment.** The Allure
  writer copied every attachment into `allure-results/`; on the project
  above that was 9.0 GB of trace zips under `records/` and the same 9.0 GB
  again under `allure-results/`. The writer now hard-links the file, to the
  temp name first and then renamed, so the atomicity `allure watch`
  depends on holds as before; Allure opens the file by name and never
  writes to it, and the link keeps the bytes alive after `nuka clean
  --records` removes the original. A link that fails (another filesystem,
  or one without hard links) falls back to the copy it made before.

## 0.10.1 — 2026-09-02

### Fixed

- **A secret spelled inside an object key survived into a step record.**
  `redact` walked object values and copied every key through untouched, so
  a key carrying a secret reached the record verbatim while the same secret
  in a value was replaced. The function's own docstring said it redacts
  every string found anywhere inside the value, so the code contradicted
  the contract it published. Reachable through a step's own `returns` or
  `declared`, where keys come from user code rather than a type; the
  fixed-shape records were never affected, and a secret in a URL's query
  string was already redacted because the URL is a value.

  Keys now go through the same replacements values do. Two distinct keys
  can therefore redact to one string, and rather than let the second
  silently overwrite the first and drop a whole subtree, `redact` throws
  and names both keys. The shape that reaches it is one key already
  spelling `{{secret.TOKEN}}` as ordinary data beside a sibling holding the
  raw value that token stands for.

## 0.10.0 — 2026-08-30

### Added

- **`nuka run` accepts more than one feature target.** Each positional can
  name a file, a `file:line` selection, or a directory. The run deduplicates
  the selected files, sorts their repository-relative paths in byte order,
  and keeps one run_id, summary, exit code, messages stream, and Allure
  results tree for the full selection.

- **`nuka check` identifies an omitted pair of quotes for a string
  parameter.** When exactly one registered pattern explains the undefined
  line, the finding names that step and pattern and gives the rewritten
  Gherkin line.

- **`nuka run` names failed scenarios after its summary.** Each line gives
  the feature, line, and scenario name. Serial and concurrent runs print the
  lines, and `--quiet` keeps them.

- **`nuka tend` reports expensive scenario openings shared in the most
  recent run.** The `repeated-scenario-prefix` note names the shared steps,
  scenario count, measured time, and share of summed scenario time. It
  reports one depth per nested family and stays quiet below two scenarios
  or two percent.

- **`nuka run --concurrency <n>` runs more than one feature file at a
  time.** The default stays 1, where every scenario runs exactly as it did
  before. Above 1, the run hands whole feature files to `n` worker
  processes: each worker runs its own files through the same serial engine
  a `--concurrency 1` run uses, and the parent keeps one run_id, one
  summary, one exit code, one messages stream, and one Allure results
  tree. stdout still carries one scenario record per line, now in
  completion order rather than file order; the per-step and per-scenario
  progress lines on stderr are now held until their own scenario finishes,
  then written together, so lines from two scenarios never interleave. A
  file tagged `@nukadoko:serial` on its own `Feature:` line runs while no
  other file runs. `--session` drops concurrency to 1 and says so on stderr,
  since a session hands state from one scenario to the next; a target
  naming one feature file has nothing to distribute, so it also runs at 1.
  `nuka check` reports `serial-tag-on-scenario` when `@nukadoko:serial` is on a
  `Scenario:`/`Scenario Outline:` line instead, where it has no effect.
  `"process"`-scope fixtures and BeforeAll/AfterAll now run once per
  worker rather than once per invocation, which coincides with once per
  invocation at the default concurrency of 1: a worker is a process, and a
  `"process"`-scope fixture already meant "once per process."
- **A step that runs for minutes now shows what it is doing, in a live
  Allure report.** Between the snapshot written when a step ends and the
  one written when the next begins, a long step used to leave the report
  untouched, so a scenario that was working looked identical to one that
  had hung. The emitter now writes a snapshot every ten seconds while a
  step runs, drawing that step with no status, a `stop` that advances each
  tick, and its live activity as child steps one flat level deep. Two
  sources feed those children, and both carry words a person wrote: a
  `ctx.poll` call still retrying contributes `waiting for: <description>
  (attempt N)`, and each `ctx.section` label reached so far contributes
  `section: <label>`. Measured against a real run under Allure 3.14.3: a
  page left open on the scenario followed a 48-second poll through
  `attempt 20` to `attempt 80` with its clock moving 10s to 40s, on its own
  reloads, with no hand on the keyboard.

  When a running step has neither a poll nor a section to report, nothing
  is written. A tick that could only say how long the step has been running
  costs a whole-page reload to tell a reader what they can already see. The
  consequence to know: a step running with no poll and no section looks
  exactly like a step that has not started.

  The interval is ten seconds and is not configurable, since it answers how
  long a person waits before a live view reads as stalled, and that does not
  vary by project. One step stops after 120 ticks. A live child is redacted
  where it is built, unlike every other value on a snapshot, which arrives
  off a step record that was redacted when it was written.

  One cost, bounded by that cap: Allure ingests every snapshot as a retry,
  so the report a watch session builds lists one retry row per snapshot,
  and a heartbeat adds rows for time rather than for steps. A report
  generated afterward from a finished results directory carries none of
  them.

## 0.9.0 — 2026-08-27

### Changed

- **`nuka accept` narrows every step record it embeds down to the fields a
  step's own contract named.** A record used to carry `actions`,
  `page_events`, `sections`, `polls`, `declared`, `http_omitted`, and
  `truncated` as well; it now keeps `step_record_id`, `step`, `kind`,
  `status`, `args`, `result`, `error`, `used`, `mutates`, `observed`,
  `calls`, `fixtures`, `required_env`, `world`, `started_at`,
  `finished_at`, `environment`, `session`, `session_execution`,
  `scenario_record_id`, `run_id`, and `target_version`. A hook entry keeps
  `type`, `status`, `error`, and `step_index`. The measurement behind the
  cut: two scenarios covering 14 steps produced a 3,844-line record, and
  `actions` alone was 2,288 of those lines. A record that size gets
  gitignored, which leaves the sign-off out of the repository and out of
  review. What the dropped fields hold is evidence for diagnosing a
  failure, and `accept` freezes a green run only, so the run a record
  freezes never had that failure to diagnose. Every dropped field still
  lands on the step record under `.nukadoko/`. The narrowing works as an
  allowlist, so a field the step record gains later stays out until it is
  named, and the record states once, near the top, every key it dropped.
- **Each scenario in a record now carries a summary table**: `step`,
  `status`, `ms`, `mutates`, `reads`, `writes`. With the embedded JSON
  this narrow, the table is the surface a reviewer reads.
- **`nuka tend`'s `post-navigation-read` note now reads step records under
  `.nukadoko/records/steps/`, rather than a committed sign-off record.**
  The note needs a step's own `actions`, and a step record carrying none
  is silently out of scope, so leaving the note where it was would have
  retired it without saying so. Reading the tool's own step records also
  widens what the note covers: a step nobody has signed off already has a
  step record from the run that exercised it. A project has nothing to do
  about this; run a feature again to get the note back for its steps.

### Fixed

- **`__waitInfo__` no longer lands among a step's own `actions`.**
  Playwright's own client library opens an internal console, weberror, and
  requestfailed watch on every BrowserContext, and that watch's
  before/after pair skips the check a real API call passes before being
  recorded, so it reached `trace.trace` under the method name
  `__waitInfo__` carrying no selector, url, or expression of its own. A
  step record listed it, and an Allure report drew it as a bare,
  meaningless step name. It is dropped when the trace is parsed rather
  than when a report is drawn, since it was never a call the step made.
- **A live Allure report could show an arbitrary stage of a running
  scenario, rather than its newest one.** Allure picks the canonical result
  among files sharing one `retryHash` by the greatest `start`, and falls
  back to ingest order when two of them tie. Every progress snapshot of a
  scenario carried one identical `start`, so that fallback decided the
  outcome, and the directory read `allure generate` uses sorts by file name
  and then reads concurrently, which leaves its ingest order unrelated to
  write order. Seven snapshots of a seven-step scenario, captured mid-run
  and replayed against that path, gave a canonical result showing 0 of the
  7 steps resolved when ingested in reverse write order, and 4 of the 7 in
  the alphabetical order that path itself uses. Each snapshot now takes a
  `start` one millisecond above the snapshot before it, the first one
  `stepCount + 2` milliseconds below the scenario start, so the greatest
  `start` alone picks the canonical result and the real result still
  outranks every snapshot. One limit stays and lives upstream: a scenario
  detail page opened during `allure watch` pins the routing id it opened
  with and keeps showing that snapshot, so a fresh page load is what
  reaches the newest one (docs/spec.md "Allure emitter").
- **A scenario detail page opened during `allure watch` now follows the run
  instead of freezing on the step it opened with.** A detail page's route
  is a hash of the result's own uuid, and a reload keeps the URL fragment,
  so a fresh uuid per snapshot left every open page pinned to whatever had
  landed when it opened. Every snapshot of one scenario now shares one
  uuid, generated when the scenario starts, and arrives under a fresh
  `<uuid>-<sequence>-progress-result.json` name, which is what the watcher
  needs to see it at all: Allure reads a result's uuid from the JSON body,
  never off the file name. Measured against a real run under 3.14.3, a
  page left open moved 0/7 through 6/7 across eight of its own reloads,
  where the same page on the previous scheme read 0/7 on all eight; the
  scenario list stayed populated throughout, polled every 50ms; and the
  watch process grew roughly a third as much over 250 snapshots. Two
  limits stay, both measured: that page never reaches the real result,
  which lands on a route of its own, and it tops out one step short,
  because a scenario's last snapshot is written and swept inside the 300ms
  the watcher waits between polls.

## 0.8.0 — 2026-08-26

### Added

- **A CommonJS project (no `"type": "module"` in `package.json`) can now
  use nukadoko.** `nuka init` now writes `nukadoko.config.mts` there
  instead of `nukadoko.config.ts`, and says on stderr that step files need
  the same `.mts` extension; `nukadoko.config.mts` joins
  `nukadoko.config.ts` as a name `nuka check`/`nuka do`/`nuka run`/`nuka
  steps` all resolve, and the two existing at once is refused rather than
  silently picking one. Before this, the only way in was switching the
  whole project to `"type": "module"`, which this door exists specifically
  to avoid asking for. `nuka scaffold` writes `.mts` in such a project
  too, so nothing generates a file the same project then cannot read.
  Where a `.ts` step file does fail to import there, every command that
  reports it (`check`, `steps`, `describe`, `run`, `do`) names the cause:
  Node's own `Cannot find module` message stands for a file that is
  plainly present, so alone it reads as missing rather than as misread.
- **`nuka check --codes` lists every finding code `nuka check` can
  produce, each with a one-line description.** `nuka check --json` only
  ever reported the current project's own findings, never a catalog of
  what the checker knows how to find at all, so a claim the README made
  about `--json` answering "what can this catch" had no command behind
  it. `--codes --json` returns the same catalog as a sorted array; plain
  `--codes` prints one tab-separated line per code. The registry backing
  it (`src/check/codes.ts`) is also what `CheckIssue.code`'s type is now
  derived from, so a code that isn't registered there fails to compile
  rather than silently drifting out of the list.
- **`nukadoko` re-exports zod's `z`, so `import { defineStep, z } from
  "nukadoko"` is the only import a step file needs.** A step file that
  imported `zod` directly still worked under npm, which hoists a
  dependency's own dependencies to a project's top-level `node_modules`,
  but not under a package manager that keeps them nested where the
  dependency declared them; `zod` was never a step file's own dependency
  to import in the first place. `nuka scaffold`'s generated template
  follows the same shape.

### Changed

- **Allure output now follows the allure-cucumberjs scenario structure.**
  Each pickle produces one scenario result with Gherkin entries in
  `steps[]`. The former step results, separate `Scenario: ` result,
  `parentSuite` and `suite` labels, and `nukadoko.grain` label are removed.
  Results now use `feature`, `package`, and `tag` labels plus `titlePath`.
  Examples cells are visible parameters. Data tables and doc strings are
  attachments, and scenario evidence attaches directly to the result.
  Live reports still update after each step through temporary progress
  snapshots, which nukadoko removes when the scenario finishes.

- **`nuka init`'s generated `nukadoko.config.ts` (or `.mts`) points at
  where the rest of its own keys are documented.** A bare
  `defineConfig({})` gave no hint that `baseURL`, `environments`, and
  everything else `defineConfig` accepts are all listed in one place; the
  generated file now carries a one-line comment naming that place
  (docs/spec.md's config key table), and, when neither `--base-url` nor
  `--features-dir` filled the object, two of the keys most projects reach
  for first, `baseURL` and `environments`, commented out as a starting
  point.
- **`nuka scaffold`'s generated step template shows a commented-out
  `pattern` line.** The template already omitted `pattern` on purpose (a
  scaffolded step defaults to CLI-only vocabulary), but the generated file
  gave no way to tell that apart from a field simply left unwritten. The
  commented line now says, in the file itself, that `pattern` binds the
  step to a feature line and is unnecessary for a step only ever called by
  name.

### Fixed

- **`nuka session start` no longer refuses in a deep project.** Its own
  unix socket used to live under this project's own `stateDir`
  (`cache/sessions/<env>/<name>.sock`), so a worktree, a monorepo package,
  or any nested checkout deep enough pushed that path over this platform's
  own limit on a socket path, and a live session could not start at all —
  with no workaround that actually helped, since the fixed part of that
  path alone already used up most of the budget. The socket now lives in
  its own directory under the OS's own temp directory instead, picked at
  random and unrelated to this project's own path, so its length no longer
  depends on where a project sits; the daemon's own lock file names the
  real path once it exists, and every other command that needs to reach a
  live session reads it from there.
- **`nuka harvest` no longer writes raw ANSI escape codes into a draft's
  comments.** A failed step record's own error message can carry a
  terminal's own color codes (Playwright's dim/reset styling around a
  "Call log:" line, for one); those reached the assembled `.feature` file
  unchanged, since nothing stripped them before they were written to a
  comment. They are stripped now, wherever an external message lands in
  the draft; the words around them are unchanged.
- **`nuka tend`'s `post-navigation-read` note no longer repeats the same
  fact once per accepted record.** A Background step runs in every
  scenario, so a suite with two dozen scenarios used to produce two dozen
  identical notes for that one step. Every note that shares the same
  step, the same navigation call, and the same call right after it is now
  one note, naming how many step records it happened in and the gap's own
  range, with one example record's path rather than every one of them.

## 0.7.0 — 2026-08-22

### Breaking

- **An args key a step's schema does not declare is refused now, not
  silently dropped.** `nuka describe` already publishes an object `args`
  schema as JSON Schema with `additionalProperties: false`; the runtime
  used to strip an extra key instead of rejecting it, since a zod object's
  own default parse mode for an unrecognized key is "strip", so the
  published contract forbade something the engine still allowed, and that
  key then reached the step record it produced. Every path that turns a
  step's `args` into a validated value now parses against that same
  closed shape: `nuka do`, `nuka do --session <live>`, `nuka run`,
  `recordStep`, and the `call` fixture a part is invoked
  through. A key `from` or `--use` fills is never flagged, since either
  can only ever name a key the step itself declared. A successful step
  record's own `args` is the validated value now too, so a key filled by
  the schema's own `.default(...)` appears in it even when the caller
  never typed it; a failed record keeps exactly what was given. A part's
  own `CallEntry.args` stays raw on both outcomes deliberately: what
  changed here is what gets accepted, not what gets written down. See
  [docs/upgrading.md](docs/upgrading.md) for what a project already
  relying on the old behavior needs to check.

### Added

- **A second door, for a suite written against Playwright Test rather
  than cucumber-js.** The first door works by swapping an import, and a
  Playwright suite has none to swap. This one shares the implementation
  instead: an operation moves into a plain function over Playwright's own
  objects, and both the spec and a typed step's `run` call it. Neither
  runner loads the other's files, so reversing it means deleting the
  feature files and the steps, after which the suite is untouched because
  nothing it uses ever knew nukadoko existed. The contract goes in that
  same shared file, since `args` and `returns` are plain zod schemas, so
  one definition serves both homes and they cannot drift into disagreeing
  about a shape. Both trees can live in one repository either side by
  side or with `featuresDir` nested inside the directory the specs
  already live in, and the two ways to get the placement wrong are both
  caught: a spec inside `featuresDir` fails to import and `nuka check`
  names it, and a step file named like a spec becomes a second step with
  the same pattern, reported as `ambiguous-step`.
- **`recordStep`, so an existing suite can migrate by running rather
  than by rewriting.** Sharing an implementation still left a Playwright
  run producing no step record, because the executor that writes one is
  not in that home. Calling this from a spec runs the step against that
  spec's own `request`, enforces its schemas, and writes a step record
  where `nuka do`'s records land, so the journeys a suite already encodes
  become drafts through `nuka harvest`. A step record gained `kind:
  "external"` for it, a third answer to how an execution came about,
  which `harvest` accepts and which cannot be mistaken for something a
  person typed. The injected request context is logged and redacted like
  any other and never disposed, and a step whose fixtures reach for a
  browser is refused before any record exists unless the call passes a
  `page` as well (see the next entry).
- **`recordStep` takes a `page` and a `use` list.** A real
  Playwright suite is written around the browser, so taking only
  `request` would have missed most of what this exists for; the context
  comes from `page.context()` rather than being accepted separately.
  Evidence listeners attach to a context the caller owns, so they are
  removed again when the execution ends. `use` means what `nuka do --use`
  means and is resolved by the same code: without it, a spec that passes
  the previous result in a variable records no chain, and the harvested
  draft carries a value that was true exactly once, which passes against
  a server that still remembers it and fails against a fresh one. An
  external record is narrower than a `nuka run` one by design: no trace,
  no screenshot, no `http.jsonl` for page traffic, since Playwright
  already produced all three.
- **A selftest scenario drives one shared implementation three ways**, a
  real `playwright test`, a real `nuka run` and a real `nuka do`, and
  checks that a step record carries the value the shared helper returned.
  That last assertion is the one that would catch the sharing having
  quietly become two implementations that happen to agree.
- **`nuka clean`, since nothing before it ever deleted what a run
  writes.** Five runs leave five runs' worth of step and scenario records
  (`records/steps/<id>/`, `records/scenarios/<id>/`), and one run that
  opens a browser leaves megabytes of trace beside them. It deletes
  `records/`, `cache/sessions/<env>/`, and `export/` under the state
  directory, selectively (`--records`/`--cache`/`--export`, or all three
  when none is given) or as a `--dry-run` preview that reports exactly
  the plan the real run acts on. It refuses the whole command, not only
  the cache, while any session in any environment is live, since that
  process is still writing records and can still emit exports, the same
  rule `nuka session clear` already applied to a live lock, generalized
  here to every category. Allure's own `allure-history.jsonl` is never a
  target: it is the one artifact here that cannot be produced again by
  running the suite.
- **`nuka tend` gains `feature-never-signed`, for a feature no
  acceptance record has ever named.** The three existing sign-off
  findings all started from a record that already exists and asked
  whether it had gone stale; none asked whether a feature was signed at
  all, which is the quiet way sign-off actually fails, since nothing
  looks for a pull request missing a file. It is a note, not an error: a
  feature still being drafted has no sign-off yet, and accepting comes
  after checking and running, so flagging that as broken would leave
  every feature in progress red. Being inside `featuresDir` does not
  silence it, unlike the staleness findings, which go quiet there because
  a frozen claim stops mattering once the suite runs a feature unattended;
  whether it was ever signed is a different question.
- **A CI recipe, `docs/ci.md`, with a workflow file to copy whole.** The
  README's own CI section is a two-line excerpt, and was leaving out what
  a project migrating from `npx playwright test` has to add by hand:
  `nuka run` does not read `playwright.config.ts`, so its `webServer`
  never starts the app and the first run meets `ECONNREFUSED`; the
  browser needs `--with-deps` on a Linux runner; and `nuka tend` needs
  its own schedule, since nothing runs it otherwise.

### Fixed

- **A malformed `from` entry no longer takes the whole vocabulary down
  with it.** Deciding between a single tuple and a list of them checked
  only whether the entry's first element was an array, which a string or
  a bare `Step` both answer wrong, so either one reached the nine call
  sites that expect a two-element tuple and crashed: `nuka steps` and
  `nuka check` failed entirely, with no file, step, or key named, and the
  string case rendered a fixed, meaningless string instead of crashing at
  all. The shape decision now judges the whole entry, and the one step
  whose entry is malformed is reported as unreadable (`from_errors`, on
  `nuka steps --json` and `nuka describe`) rather than emptying the
  listing for every step beside it.
- **`nuka steps` and `nuka describe` exit non-zero on a step with an
  unreadable `from` entry**, matching the exit-code rule they already
  applied to an import failure or an unreadable `needs`. `describe`
  judges only the one contract it printed, so a healthy step next to a
  broken sibling still exits `0`.
- **`nuka init` now adds `.env` and `.env.*` to the project's
  `.gitignore` (re-including `.env.example`).** A tracked env file is
  the one door a secret can reach a run record through in plaintext: an
  untracked one is already classified as a secret source and redacted,
  but a tracked one is ordinary config to everything downstream, and
  `check`'s own secret-name heuristic (a key whose name looks like a
  secret) says nothing about a key named, say, `AUTH_STRING`. `init`
  already writes to `.gitignore` and already reads env files, so it
  closes the gap instead of only reporting it.
- **`nuka check` now names the step line a finding is about, not the
  `Scenario:` line it sits under.** All seven line-bearing findings, in
  both the text output and `--json`, used to report the pickle's own
  scenario location, since the check path dropped the parsed document a
  pickle step's own line resolves through. A Scenario Outline resolves to
  the template's own line, not the row's. A scenario record written by
  `nuka run` is unaffected; it already carried the scenario's own line.
- **`nuka check <feature>:line` now says the line syntax is unsupported,
  instead of reporting the file as not found.** `check` reads a whole
  file and a line means nothing to it, so the refusal was already
  correct, but the message sent the reader looking for a missing file
  that was right where it was named. It now says why a line is
  meaningless here and what to run instead; a genuinely missing file
  still reports a missing file.
- **`nukadoko.config.ts`'s unknown-key error now names the correctly
  cased key when casing is the only thing wrong**, for example
  suggesting `baseURL` for a written `baseUrl`. Only an exact
  case-insensitive match is named; nothing looser is offered, since a
  check that guesses is worse than no check.
- **`nuka describe` now includes a step's `needs`/`needs_browser`,
  matching `nuka steps --json`.** The command already calls its own
  output the full contract; reading the fixtures a step needs used to
  mean calling `steps --json` as well. `describe` also exits non-zero
  when it cannot read them, the same rule it already applied to an
  import failure.
- **`nuka session start` refuses up front when its unix socket path
  would exceed the platform's length limit**, naming the path, its
  actual size, and the limit, instead of the daemon exiting with no
  output at all. When the daemon fails to start for some other reason,
  it now writes what it caught to a file beside the socket and the
  failure message points at it, so a cause nobody predicted stays
  reachable.
- **Two `nuka run` invocations against the same project no longer
  collide in `messages.output`.** The file was truncated at the start of
  every run and both processes wrote into it, so a second run starting
  before the first finished cut the first run's stream in half and
  appended its own: a file no single run could have produced, with
  neither run failing or warning about it. Each run now writes its own
  file, named for its run id beside the configured path
  (`messages.<run_id>.ndjson` under the default path), and the
  configured path becomes a copy of the most recently finished run's
  stream, placed there by rename so a reader never catches it half
  written. `nuka clean [--export]` removes both the configured path and
  every run's own file beside it. See
  [docs/upgrading.md](docs/upgrading.md) for what changes for a script
  that watches this file.

## 0.6.0 — 2026-08-18

### Added

- **A session can stay live, so exploring does not have to start from
  nothing every time.** `nuka session start <name>` holds one `ctx` open
  in a process; `nuka do --session <name>` then lands on it instead of
  building a world from scratch, and `nuka session stop <name>` ends it.
  What persists is the whole context rather than the browser alone:
  persisting only the browser would leave a world that is half old, a
  fixture rebuilt for this execution sitting beside a page five
  executions deep, with nothing saying which parts are which. This is not
  a new lifetime either. A scenario already builds one `ctx`, runs
  several steps against it, and tears it down, so a live session is that
  same lifetime with the steps arriving one at a time, and the two
  fixture scopes need no third value.
- **The rendezvous is the lock file that already existed.** A session's
  `.lock` holds `{ pid, started_at }` and is already checked with
  `process.kill(pid, 0)`, with a dead pid's lock already defined as stale
  and free to take over. `nuka do --session` finds a live pid there and
  hands its execution to that process, finds none and behaves exactly as
  before. Stopping writes storageState to the same file a session has
  always left behind, so a session has two lifetimes rather than two
  meanings: a process while it lives, and the state it saved once it does
  not.
- **A step record from a live session says so**, through a new
  `session_execution` counting this execution's position in that session.
  Its presence is what marks the record as live, so no second field was
  needed. A step that passed as the thirtieth execution against a world
  nobody can rebuild has proved something different from the same step
  passing on its own, and a green record that could not be told apart
  from the other kind would quietly devalue every record beside it.
- **`nuka do --session` now says which world it ran in**, on stderr: live
  and at what position, or not live and running fresh from saved state,
  and separately when it cleared a socket left by a session that crashed.
  This is the one transition the feature introduces, and without a word
  at the time it would only ever be visible afterwards in the record.
- **`nuka run` and `nuka accept` report a live session** they find, naming
  it, its environment, and the command that stops it. They refuse nothing
  on its account: whether that session has anything to do with the feature
  being accepted is not knowable from here, so this is a fact and never a
  verdict. What it is worth saying is that the application may be holding
  state an exploration put there, which is exactly how a scenario passes
  for a reason nobody wrote down.
- Only one execution runs at a time per session, the socket carries the
  same live credentials the storageState file does and is created with the
  same restricted permissions, and an idle timeout applies by default,
  because a forgotten session is the normal outcome of an interrupted
  exploration rather than an unusual one. Nothing here can reach a
  sign-off: a live session produces no scenario record, and `nuka accept`
  already refuses without a green full run.

- **`nuka harvest` turns a `nuka do` sequence into one feature draft.**
  `nuka do` was already the adaptive loop, where an agent reads one
  validated result and decides the next call, but what it leaves behind is
  deliberately not evidence. So an exploration that found something real
  ended with the finding in a form nothing could gate on, and the path it
  took living only in a directory that is safe to delete. Harvest is the
  bridge: `nuka harvest <step-record-id>... > x.feature` writes the lines,
  their order, and which values chained rather than appeared on a line,
  all read out of what was measured. The ids are the ones each `nuka do`
  printed, and their order in the draft comes from each record's own
  `started_at`, so order stays a measurement while the argument list stays
  a selection. There is no time window and no `--since`, because a window
  cannot tell the probe that was tried and abandoned from the call that
  mattered.
- **Every claim in the draft is left blank on purpose.** Each line's
  keyword is `*` and both names are placeholders, because a step record
  says what ran and nothing about what any of it was for. Deriving the
  keyword from `mutates` was the alternative and it loses on one ground: a
  plausible keyword survives review, and `*` does not. One call is one
  scenario, since where one story ends is not in the records either.
- **Three things the draft names rather than decides**, each on stderr as
  well. A step with no `pattern` becomes a comment, since it cannot be a
  line and whether it was a step or a part is a judgment about the
  scenario. A record whose execution failed becomes a line with the
  failure said out loud, which is what makes a reproduction harvestable:
  red, fixed, green, then accepted, with `nuka accept` refusing while it is
  red. And a line that does not read back to the record it came from is
  named with both what was written and what it read back as.
- **The draft is verified against itself.** Reversing a pattern has no
  single answer where one carries optional text (`item(s)`) or alternation
  (`is/are`), so rather than pick quietly, harvest parses the draft through
  the same gherkin entry point `run` and `check` use and puts each pickle
  step through `run`'s own matching. Parsing the real text rather than
  hand-building a pickle means the docstring and table escaping is checked
  by the same pass, and there is no second matcher to disagree with the
  first.
- **Provenance goes to stderr and never into the file.** The ids point into
  a gitignored directory that is safe to delete, so naming them inside a
  committed feature would leave a reference its reader cannot follow.

## 0.5.0 — 2026-08-17

### Added

- **A step can call another step, so a step can be split without its
  feature file being rewritten.** `defineStep` takes `parts`, the list of
  steps this one's `run` may call, and the new `call` fixture runs one:
  `const project = await call(createProject, { name: args.name })`. There
  is no new kind of unit here. A part is an ordinary step, usually one
  defined without a `pattern`, which was already complete CLI-only
  vocabulary that `nuka do` runs and `nuka steps` lists; what was missing
  was a way to call one. What makes it worth having is what it leaves
  alone. The calling step keeps its pattern, its `args`, and its
  `returns`, so a scenario that was agreed with the people who decide
  what the software is for, and that may already carry a sign-off, stays
  as it is while the implementation underneath is split in two. Giving
  that same part a `pattern` later binds it as a scenario line of its own
  without taking it away from the step that calls it, which is how a
  second scenario gets half of an existing step without the first
  scenario paying for it. `parts` is declared rather than read out of the
  body because a step's fixture bag is built before `run` is called: a
  step's needs are now its own destructured names together with every
  part's, closed transitively, so a composite whose part reaches for
  `page` opens a browser. Reading `call` sites out of a body instead
  would be a parser guessing at control flow, and the guess would be
  wrong on exactly the calls that sit inside a branch. `call` refuses a
  step `parts` does not list, and refuses one discovery never registered,
  which is the mistake `ctx.resultOf` already throws on.
- **A step record carries `calls`**: one entry per part this execution
  ran, with the part's name, the args it was given, the result it
  returned, when it started and finished, and its own error when it
  failed. A part that called a part nests under that entry. These are not
  step records and carry no `step_record_id`. A scenario record's
  `steps[]` stays one entry per feature line, because a feature that does
  not name everything that ran stops being the record this tool exists to
  keep; what a part adds is depth under one of those lines. Everything
  measured stays at the step boundary as well: `observed`, `sections`,
  `used`, `required_env`, the evidence directory, and the trace are the
  calling step's, and count the parts' work inside their own totals, so
  nothing is counted twice and nothing that ran goes uncounted because it
  ran inside a part.
- **`nuka steps --json` and `nuka describe` show `parts`**, so an agent
  reading the vocabulary can see that one step is built out of others
  without opening a file, the same reason `from` is already there. `nuka
  steps`' one-line-per-step text listing is unchanged: it stays readable
  in one screen however large the vocabulary grows. A step's `needs` and
  `needs_browser` now account for its parts too, since the bag its parts
  will destructure from is the one the composite is given.
- **The Allure emitter nests a `calls` entry as a nested step** under the
  step that called it, carrying the part's args and result as parameters,
  through the reporter machinery's own nesting rather than a shape
  invented here.
- **`nuka check` gains three findings about `parts`**, all of them things
  it can be certain of without running anything.
  `part-structural-violation` names an entry that is not a `Step`, or one
  discovery never registered. `part-cycle` names a step that reaches
  itself, which can never close into a fixture bag or a terminating run.
  `part-mutates-contradiction` names a step declaring `mutates: false`
  while declaring a part that declares `mutates: true`, since `mutates`
  covers everywhere the step touches and a part it may call is part of
  that reach. That last one is also what keeps `then-mutates` reading a
  single flag on a single step instead of walking a graph. A declared
  part the body never calls is reported by nothing, on purpose: the call
  is inside `run` while the declaration names a `Step` object, so
  matching them would be a guess about an identifier, and a check that
  guesses costs more than the silence it replaces.
- **A read-only environment now refuses a `mutates: true` part**, at the
  call, before it runs, whatever the calling step declared about itself.
  Only the entry step's own flag was checked before, so a composite
  declaring `mutates: false` while calling a mutating part could reach
  the wire under a read-only policy. The static contradiction check above
  catches the same mistake earlier and more cheaply; this is what holds
  when nobody ran `nuka check`.

## 0.4.1 — 2026-08-16

### Changed

- **`skills/acceptance/SKILL.md` now opens with a staged entry point
  instead of assuming a scenario is already in hand.** A reader can start
  from raw prose with no stated acceptance criteria yet, from general
  acceptance-criteria sentences with no scenario yet, or from a scenario
  ready to write; all three stages funnel into the same loop (`nuka check`
  through `nuka accept`) that was already there. The prose-to-requirements
  stage reads a requirement against the five EARS patterns as a checklist
  for what has to be stated, not a template to generate wording from: a
  slot the source doesn't support becomes a question addressed to a
  person, never a filled-in guess. Lookup detail that used to keep the
  body pinned at its 500-line limit moved into
  `skills/acceptance/references/`, shipped in the same npm tarball as the
  skill itself; the body went from 499 lines to 372.

## 0.4.0 — 2026-08-16

### Breaking

- **Every id-bearing field on a step record and a scenario record now
  follows one rule: `<grain>_record_id`, or `run_id` for a run.** Before
  this, the same key name meant two different things depending on which
  record it sat on: `scenario` was an id on a step record (the owning
  scenario record's id) but a name on a scenario record (the pickle's own
  name), and a step record's own id was `record_id` on the step record
  itself but `record` inside a scenario record's `steps[]` array. A step
  record's `record_id` is `step_record_id` now; the owning scenario
  record's id on a step record, formerly `scenario`, is
  `scenario_record_id`; a scenario record's own `scenario_id` is
  `scenario_record_id`; a scenario record's `steps[].record` is
  `steps[].step_record_id`. A scenario record's own `scenario` field (the
  pickle's name, never an id) and `run_id` are unchanged, and so are the
  `step-`/`scn-`/`run-` id prefixes themselves. An existing acceptance
  record needs re-creating, the same way 0.3.0's own step record rename
  did: `nuka run` the feature again and `nuka accept` it. `nuka tend`
  reports `signoff-record-old-format` for a record it still finds under
  the old field names, which now includes every record accepted before
  this release, 0.3.0's own step records included, since `record_id` is
  exactly the field `signoff-record-old-format` already checked for.
  The same rule closes two more spots that had kept the old, bare
  convention: a step record's `used[]` entries carried the upstream id
  under `record`; that field is `used[].step_record_id` now, matching the
  name (and the value) the step record it points at already carries on
  itself. The Allure emitter's own step parameter list carried the same id
  under the bare label "record"; every other label there already says what
  it is measuring (`mutates (declared)`, `http reads (observed)`), so this
  one is "step record id" now, not a bare "record".

### Added

- **A step record now also carries `run_id: string | null`**: the owning
  `nuka run` invocation's own id for a `run`-originated step, `null` for a
  `do`-originated one, the same split `scenario_record_id` already makes.
  Reading one step record on its own used to mean opening the scenario
  record beside it just to find out which run it belonged to; the step
  record answers that itself now, the same way it already answers
  everything else about what that one execution did.

## 0.3.0 — 2026-08-16

### Breaking

- **The step-level record is called a step record now, not a receipt.**
  Step-level and scenario-level records answered the same question under
  two unrelated words: `Receipt` here, `record` for the scenario level.
  This folds them into one vocabulary, distinguished by grain (`step
  record` / `scenario record`) only where the distinction matters. What
  the old name carried was never the name itself: it was the fact that a
  step record's `result` had passed the step's own `returns` schema, and
  that fact does not move when the name does, so nothing is lost by the
  rename.
- **`.nukadoko/` now splits into `records/`, `export/`, and `cache/`, by
  purpose.** `records/` is the tool's own measurement of a run
  (`records/steps/<id>/`, `records/scenarios/<id>/`), never committed.
  `export/` (`export/allure-results/`, `export/messages.ndjson`) is
  derived output for a reader outside nukadoko, safe to delete since the
  next run rebuilds it. `cache/` (`cache/sessions/`) is not a record of
  anything that happened, only work avoided, so deleting it costs a
  login, never correctness. See
  [Artifacts](docs/spec.md#artifacts).
- **A step record's own field names and id prefix changed.** `receipt_id`
  is now `record_id`, the `rcpt-` id prefix is now `step-`, and a `used`
  entry's `receipt` key is now `record`.
- **An existing acceptance record needs re-creating.** It embeds each
  step's own record verbatim, so the field-name and prefix change above
  lands inside it too. `nuka run` the feature again and `nuka accept` it;
  `nuka tend` reports `signoff-record-old-format` for one it still finds
  in the old shape.
- **`nuka tend` no longer reports a stale sign-off, or a sign-off's
  drifted condition, once the feature it names lives inside
  `featuresDir`.** Both findings (`signoff-rot`'s four checks and
  `signoff-condition-mismatch`) used to fire for any accepted feature
  regardless of where it lived; now they skip a feature already running
  unattended, because the run itself carries the guarantee those two
  findings used to stand in for, and reporting them anyway would turn
  every ordinary edit to a feature already running unattended into an
  alarm nobody keeps reading. `signoff-record-unreadable` is unaffected:
  a record `tend` cannot even parse has no placement to judge it by. A
  project relying on `nuka tend`'s exit code to catch this for a feature
  already inside `featuresDir` loses that coverage; running that same
  feature, already scheduled on every commit, is what confirms the same
  thing now.

### Added

- **`nuka run` now also writes one Allure test result per *scenario*, on
  top of the existing one per step.** Named `Scenario: <scenario name>`,
  sitting beside its own steps' leaves in the same tree group. Unlike a
  step's own test, a scenario's own test carries an identity that stays
  stable from one run to the next (its own feature path and gherkin name,
  folded together with every step's own text so two scenarios sharing a
  name never collide), so Allure's own history, trend, and
  flaky-across-runs views work again, at scenario grain, once
  `historyPath` (below) is set. This also closes the one display
  regression 0.2.0 recorded in its own entry below: a scenario a Before
  hook stops now shows `failed` on its own scenario-level leaf, not only
  `skipped` on every step underneath it. See
  [Allure emitter](docs/spec.md#allure-emitter).
- **`nuka init` now writes `historyPath` into the `allurerc.mjs` it
  generates**, pointing Allure's own `generate`/`watch`/`report` at
  `.nukadoko/export/allure-history.jsonl`. Without it, Allure never builds
  history at all, no matter how stable a scenario's own identity is;
  `examples/allure/allurerc.mjs` now carries the same field, for a
  project not using `nuka init`.

### Changed

- **`nuka accept` now writes guidance to stderr after a successful
  sign-off**, naming the choice a project has after freezing a record:
  leave the feature where it is, an acceptance claim about one commit, or
  move it into `featuresDir` so it runs unattended from then on. stdout
  is unchanged, still just the record's own path. The acceptance skill
  and `docs/spec.md`'s own "Sign-off" and "Tending" sections now describe
  this as a decision made once, right after sign-off, rather than the
  previous framing, which read strongly enough to be taken as a rule
  against ever running an accepted feature at all.

### Fixed

- **`nuka accept` no longer refuses a second feature just because the
  first accept, from the same green run, left its own record untracked.**
  The dirty-tree refusal protects the tree a run actually read (a step
  file, a feature, the config); an acceptance record is what accepting
  produces, never an input to the run being frozen, so its being
  untracked or changed no longer counts against that refusal, for any
  feature. A path this cannot even read (most likely one deleted since it
  was measured) still counts as dirty, and anything else dirty still
  refuses exactly as before. See [Sign-off](docs/spec.md#sign-off).

## 0.2.0 — 2026-08-15

### Breaking

- **`nuka steps --json`'s top level changed from a bare array to `{ steps,
  import_failures }`.** Anything reading the old bare array needs to read
  `.steps` now; `import_failures` (`{ file, message }`) is new alongside
  it, always present, `[]` when nothing failed.
- **Allure now writes one test per step, not one test per scenario.** A
  run used to put nothing on screen until a scenario was over, so a
  20-step scenario that takes minutes showed a blank report the whole
  time; Allure only updates when a new result file appears and never
  re-reads one it has already seen, and it has no way to show a test that
  is still running, so the only unit it can update at is one finished
  test. Mapping a step to a test was the only way to get feedback at step
  granularity instead of scenario granularity (measured: first result
  lands within 150-351ms of that step finishing). The scenario moves into
  the `suite` label and the feature stays `parentSuite`, so a suite row
  still carries the whole scenario's tally and turns red as soon as one
  of its steps does. This costs Allure history: four ways of identifying
  a step across runs were measured, and every one mis-links two
  different steps as the same one (text collides with itself, position
  shifts on any earlier edit, occurrence counting cannot tell an
  inserted duplicate from the original), so nothing links a step's
  `historyId` across runs any more, on purpose, via three hidden
  parameters that change every run. A migrated suite that kept a
  cucumber-shaped report tied to its old history would have gained
  nothing by moving; the compat door is for getting a suite in, not for
  where it settles, and time-over-time observation stays available
  through `nuka tend` instead (see
  [Allure emitter](docs/spec.md#allure-emitter)). One display
  regression: a scenario stopped by its own Before hook now shows every
  step `skipped` rather than one test turning red, because there is no
  longer a scenario-level test for that failure to live on; `nuka run`'s
  exit code and `record.json` are unaffected, and `nuka accept` is
  unchanged, since the acceptance unit was always the scenario, never
  the Allure report.
- **`nuka steps` now fails when the project has no features directory.**
  It used to print an empty vocabulary and exit `0` there, which reads
  exactly like a project whose features directory exists and simply holds
  no steps yet. Those are different facts, and `nuka check` already told
  them apart: `nuka steps` was reusing discovery's own leniency, where a
  missing directory means "nothing found here" so that an empty
  vocabulary stays a valid answer. The cost landed on the reader who
  reaches for `nuka steps` first, an agent taking its opening move, who
  got a plausible empty answer instead of being told it was in the wrong
  place. Now the resolved path it looked for is named on stderr, stdout
  stays empty in both plain and `--json` form rather than carrying an
  error-shaped payload, and the exit code is non-zero. A features
  directory that exists and holds no steps is unchanged: `{ "steps": [],
  "import_failures": [] }` and exit `0`.

### Added

- **`nuka steps` and `nuka describe` now read the vocabulary per file,
  tolerant of a broken glue file.** One step file that failed to import
  used to take the whole call down with it, which meant the one moment a
  suite mid-migration most needed to read its own vocabulary was exactly
  when these two commands went blind. Now the rest of what discovery could
  read still comes through: the broken file is named on stderr and in
  `import_failures`, and the command still exits 1, since output is not
  withheld but "this succeeded" is not claimed either. `nuka run`, `nuka
  do`, and `nuka init` are unchanged: they are about to execute, or set up
  a project that is about to, so they stay fail-fast on purpose.
- **A typed step's `run()` that this same static reading cannot parse no
  longer empties the whole listing.** `needs` is `null`, with a
  `needs_error` string beside it, instead of throwing the step, and every
  other step, out of `nuka steps` entirely; human output marks the entry
  `needs unreadable` and prints why.
- **That same unreadable `run()` also gets `needs_inferred` for one shape:
  a bare, un-destructured first argument (`run(ctx, args)`, the shape 0.1.0
  replaced with a fixture bag).** A lexical guess at the step's fixture
  needs, read from that argument's own member accesses and filtered to
  known fixture names; a field of its own, never merged into `needs`, and
  never producing `needs_browser`. It misses an alias (`const c = ctx`), so
  it is a starting inventory, not a finished one, and it is simply omitted
  for the other unreadable shapes (a default value, a rest property),
  which carry no identifier to scan by in the first place.
- **`nuka check`'s human output groups a `step-file-import-failed` message
  shared by more than one file.** The message prints once, followed by the
  sorted file list, instead of once per file; a single broken file still
  renders exactly as before, and `--json` is unchanged.
- **`nuka tend` adds one `import-failures-unseen` note when a step file
  could not be imported.** Its own counts and findings were already
  shrinking around a broken file with nothing here saying so; this names
  how many files went unseen and points at `nuka check` for detail.
- **`nuka run` no longer runs silent.** stderr now carries a boundary line
  before each scenario, one line per step as it finishes, every path the
  run actually wrote once it ends, and a one-line summary; a new `--quiet`
  flag drops the two progress lines only, since naming where output landed
  is never worth suppressing for a flag whose whole point is a quieter
  terminal, not a silent one. stdout is unchanged: still NDJSON only, one
  scenario record per line.
- **`nuka tend` adds a `post-navigation-read` note.** For a step whose
  frozen sign-off record shows a call landing shortly after `goto`,
  `reload`, `goBack`, or `goForward` finished, it reports the gap: not a
  verdict that the gap was too short, since only the application's own
  render time decides that and this tool has no way to know it, only the
  fact of how much time passed. A read inside a `ctx.poll` window is
  excluded, since a step written that way is already retrying. Never
  changes the exit code.
- **`docs/upgrading.md` (paired with `docs/upgrading.ja.md`) covers moving
  a project already on nukadoko to a newer release.** `docs/migration.md`
  is for a cucumber-js suite coming in; upgrading is the separate question
  of what an existing nukadoko project has to do about a breaking change,
  split into what stays the same every release and what changed in this
  one.
- **`nuka init` now writes `allurerc.mjs`.** Allure 3's `allure generate`/
  `allure report` read failure categories only from its own config, never
  from a results directory's `categories.json`, so without this file every
  nukadoko failure collapsed into Allure 3's one built-in "Product errors"
  category instead of one of the seven `error.kind` ones. The file's seven
  rules are built from `NAME_BY_KIND` (`src/report/allure/categories.ts`),
  the same source `examples/allure/allurerc.mjs` has always been checked
  against, so the two can never drift apart. `init` checks all six
  extensions Allure auto-detects (`allurerc.{js,mjs,cjs,json,yaml,yml}`)
  first and writes nothing, naming the file it found on stderr, when a
  project already has one.
- **The Allure report is now confirmed against a real browser, not just
  against `allure-js-commons`' own API.** A selftest scenario runs `nuka
  run` against a small fixture with a passing, a failing, and a
  Before-hook-stopped scenario, generates the report with the real
  `allure` CLI, serves it over a real HTTP server, and drives a real
  headless browser against it, reading only data-dependent content (a
  count, a tree row, a status), never the report shell's own boilerplate.
  Confirmed this way: pass/failed/skipped counts match what `nuka run`
  itself reported, a scenario renders as its own group and a step as one of
  that group's rows, a failed step's `receipt.json` attachment is present
  and its own content is readable, `allurerc.mjs`'s categorization actually
  sorts a failure away from "Product errors", and a step's `sections`/
  `polls` render as its own child steps, one level under it, not two.
- **`allure watch` updating live, not just a finished report, is now a
  repeatable check, not a one-off scratch script.** README and
  docs/spec.md already said a run's report can be watched from before the
  first `nuka run` and re-renders as each step finishes; nothing had
  confirmed that claim more than once. A selftest scenario now starts
  `allure watch` against an empty results directory, opens the report in a
  real headless browser exactly once, and spawns `nuka run` against a
  fixture with deliberately slow steps without waiting for it to finish, so
  the browser tab is read while the run is still going. The mid-run count
  it observes has to sit strictly between 0 and the run's own final total,
  or the scenario fails: that in-between reading, arriving with no
  `.goto()`/`.reload()` from the test itself, is the only evidence a
  report update actually arrived on its own.
- **A browser-driven run's own evidence now reaches a real report too.**
  Stage 2 above read a finished report and stage 3 watched one update live,
  but neither ever launched a browser inside the run under test, so the
  Playwright-native redesign's own artifacts (a trace per step and per
  hook, that trace's own calls as child steps, `page_events` counts, a hook
  that touches the browser as its own fixture) had never been opened on
  screen. A new selftest scenario runs a fixture feature whose Before hook
  and step both navigate a `data:` URL (`page.setContent()` never produces
  a `goto` action; a real navigation does) and confirms all four: the
  step's own trace attachment downloads as a valid, non-empty zip; the
  Before hook renders as its own fixture; the trace's own `goto` action
  shows up as a child step, the same locator stage 2 already uses for
  `section:`/`poll:`; and each `page_events` category's parameter reads the
  same count the step's own receipt recorded. Kept in a feature of its own
  so stage 1 through stage 3 keep their existing runtime.
- **`nuka run` now takes a directory in place of a single feature file.**
  `nuka run features/` walks it recursively for every `.feature` file and
  folds all of their pickles into the one invocation: one run_id, one
  summary, one exit code, one messages stream, one Allure results tree, in
  a fixed order (the repo-relative path compared byte by byte, not by
  locale) so a record or a report stays comparable across runs. `:line` on
  a directory is refused, and a directory with no `.feature` file anywhere
  under it fails setup, naming what it walked, the same tone `nuka check`'s
  own `no-step-files-found` uses. README's own CI example
  (`npx nuka run features/`) now runs as written.
- **An unknown parameter type now names the ones this project has.**
  `{count:number}` is a natural thing to write and cucumber-expressions
  answers it with "Undefined parameter type 'number'", which says what is
  wrong without saying what would be right. The message now carries the
  names actually registered for this project, read from the live registry
  rather than a fixed list, so the ones a project added through
  `config.parameterTypes` or a compat `defineParameterType` appear beside
  the built-in ones. A list written into a document could not have done
  that, and would have been wrong for exactly the projects that extended
  the vocabulary furthest.
- **`nuka scaffold`'s template now explains `rationale`.** The template
  guided every other field and said nothing about this one, while
  `nuka tend` flags a step that lacks it (`step-rationale-missing`), so a
  step written the way scaffold suggested was reported the moment anyone
  tended it. The comment says what belongs there (why this shape, what was
  rejected) and how it differs from `description`, which says what the
  step does.
- **`nuka accept`'s dirty-tree refusal now names the state directory when
  that is what is dirty.** A project that never gitignored it (`nuka init`
  does this automatically, but an existing project migrated by hand can
  miss it) could get stuck in a loop: dirty, commit, accept refuses because
  HEAD moved, run again, dirty again from the same state directory, forever.
  The refusal now says whether the dirty paths are entirely or partly under
  the state directory and that `nuka init` gitignores it for that reason,
  without assuming the project didn't mean to track it; a tree dirty for an
  unrelated reason gets the same message as before.
- **`nuka mcp-tools -- <command> [args...]` and `connectMcpServer`/
  `callMcpTool` (from `"nukadoko/mcp"`) reach an ordinary MCP server over
  stdio.** The first reads whatever tools a server declares and prints
  them; the second lets a hand-written step call one and throws when a
  tool reports an in-band failure (`isError: true`), which MCP itself
  returns as a normal, successful response rather than a rejected promise.
  Both are kept apart from `nuka steps` on purpose: a server's own
  declared tools are material for a person writing a step's `args` by
  hand, never something this package turns into a step or its vocabulary
  on its own. A server's process lifetime rides on the existing fixture
  mechanism instead of a new config key: a fixture calls `connectMcpServer`
  in its own setup and `client.close()` in its own teardown, the same
  setup/teardown/scope shape any other fixture-owned resource already
  uses. `@modelcontextprotocol/client` is an optional peer dependency, so
  a project that never touches this surface never installs it; `nuka
  mcp-tools`'s own CLI wiring reaches it through a dynamic import for
  exactly that reason, and names the exact version to install when it is
  missing. `connectMcpServer` connects with the client package's own
  2025-era default (no probe, no new headers) unless a caller passes its
  own `ClientOptions` as a second argument, forwarded straight to
  `Client`'s own constructor, most usefully to opt into the 2026-07-28
  handshake through `versionNegotiation`.
- **`nuka experimental webmcp-tools <url>` and `experimental_callWebmcpTool`
  reach a page's own declared tools, via `navigator.modelContext.registerTool`.**
  Both carry their mark in a position a caller cannot route around, because
  the WebMCP standard's own documentation says it is subject to change, and
  its English and Japanese pages currently disagree about whether a caller
  shaped like this one is supported at all; it measurably works against
  Chromium 149 today, and that is measured, not promised, with the
  condition for dropping the prefix written beside it. The listing is a
  separate face from `nuka steps`, deliberately: folding a page's declared
  tools into the step vocabulary would let the page under test decide part
  of the vocabulary that checks it. Calling a tool needs nothing from the
  executor but `page`, which a step already receives, so it is a plain
  import rather than a fixture. The launch flag Chromium needs is never
  injected: a project states it in its own config's `browser.args`, the
  same as any other Playwright launch option, and a page missing the API
  raises its own error rather than reporting zero tools, so "nothing
  declared" and "no API to ask" stay distinguishable.

## 0.1.0 — 2026-08-06

### Breaking

- **A typed step's `run` now takes a fixture bag, not `ctx`.** Collect what a
  step read off `ctx` into a destructured first argument (`run({ page,
  section }, args)`), and drop the `await` and call parentheses on `page`/
  `request`: they are values now, not functions. No codemod ships for this.
  See "A typed step's `run` takes a fixture bag now, not `ctx`" under Changed
  below.
- **`evidence.trace` moved off the scenario record onto each step's own
  receipt.** Anything reading the scenario record's `evidence.trace` needs
  to read the receipt of the step that opened a page instead; there is no
  longer a single trace spanning the whole scenario. See "`evidence.trace`
  is a step's own trace now, not the whole scenario's" under Changed below.
- **A sign-off record's filename now carries its condition.** The old
  `<feature-basename>.<date>-<sha>.md` is
  `<feature-basename>.<date>-<sha>.<environment>.<browser>.md` now; anything
  reading the old filename shape needs to read the new one. See "A sign-off
  is now scoped to a condition, not just a feature and a commit" under
  Changed below.

### Added

- **The Allure report carries what nukadoko measured.** Three things
  nukadoko had been recording never reached the report at all. Each step's
  own receipt is now attached whole as `receipt.json`, so a field the
  receipt gains later arrives without a second mapping to keep in sync.
  `sections`, `polls`, and now `actions` merge by their absolute timestamps
  into a child-step timeline under the step they belong to, which is what
  those `at` fields were added for: a poll renders with its real duration
  and its own outcome, and its name carries the attempt count, because one
  attempt and forty attempts ask for opposite fixes and nothing else in the
  report tells them apart. An action renders with its own real duration
  too, named after its method and target (`goto /orders`), an `expect`
  call named by its matcher and target instead (`expect #late
  to.be.visible`); never by its own duration, already visible as the child
  step's width. A truncated `actions` array gets one more child step at the
  timeline's tail naming what got cut, so the timeline alone never reads as
  the whole story when it is not. `page_events` counts appear as
  parameters, so a step that passed while the page logged three console
  errors says so without anyone opening an attachment, and a truncated
  category reads `100 of 4213` rather than the number it happened to keep.

- **A receipt now records what the page itself said.** Console errors,
  uncaught page errors, and failed requests land on the step's own receipt
  under `page_events`, so a step that passed while the page threw three
  uncaught errors is readable instead of invisible. The subscription sits on
  the BrowserContext rather than the Page, which is what lets it pick up a
  popup (`window.open`) without a second listener. Each category caps at 100
  entries; when one is cut, a sibling `truncated` field carries the true
  total, because a field whose shape changed with volume would make `jq
  '.page_events.console_errors | length'` quietly answer a different
  question. Secrets are redacted on the pass the rest of the receipt already
  goes through. Service workers stay outside this: a `Worker` has no request
  or error event to subscribe to, so what they emit is not covered.

- **A step's receipt now records what it did on the page, timed.** Every
  Playwright call a step made through `ctx.page()` lands on `actions`,
  `expect` waits included, each with its own duration (`ms`), outcome, and
  absolute timestamp. No `expect` fixture exists to make this work: a step
  reaches `expect` the same way a Playwright test file would, and the trace
  records the call underneath that wrapper. Only five parameter keys
  (`selector`, `expression`, `url`, `isNot`, `timeout`) ever reach the
  receipt; a `setContent` call's own HTML body, for one, stays in trace.zip
  where it belongs. Capped at 100 entries with the same `truncated` sibling
  `page_events` already uses. Redacted on the same pass as the rest of the
  receipt. A trace format version this build does not recognize costs
  `actions` and gets one stderr warning, never a guess.

- **http.jsonl now records the page's own traffic too, not just
  `ctx.request()`.** A step's `ctx.page()` calls used to leave no trace in
  http.jsonl at all: `observed` counted them, but the URL they hit was
  nowhere on the receipt. Every response for a `document`, `xhr`, or
  `fetch` request now lands there beside `ctx.request()`'s own entries,
  each line marked `via: "request"` or `via: "page"`, so neither reads as a
  guess. Images, stylesheets, and scripts are left out on purpose, since a
  single page load can pull in dozens, but never silently: what didn't
  make it in is counted by resource type on the receipt's new
  `http_omitted` field. `observed` is untouched by any of this; it still
  tallies every request the page made, image and script traffic included,
  because it answers a different question than http.jsonl does, and the
  two numbers were never meant to match.

- **`nuka steps --json` now reports each typed step's own fixture needs.**
  Two new fields per step: `needs` (the names its `run()` destructures,
  alphabetized) and `needs_browser` (whether `page` or `context` is one of
  them). Both were already readable, `check` parses the same destructuring
  to catch an unknown fixture name before anything runs; this just exposes
  that same static reading outside `check`, so an agent can tell, before
  running anything, which scenarios never open a browser at all. `needs` is
  never omitted for a typed step, even when it is `[]`, so "this step needs
  nothing" reads differently from a compat entry, which has neither field
  at all (no `run()` exists to read). The non-JSON listing stays terse: it
  marks a browser-needing step with a single word rather than repeating the
  full `needs` list, which stays a `--json` concern.

- **Steps can now order a project's own resources by name, not just
  Playwright's.** `nukadoko.config.ts` gains `fixtures`: a name mapped to a
  bare function, or a `[function, options]` tuple, the same two shapes
  Playwright's own fixture definitions take. This is the place a step's own
  tenant, seeded database, or uploaded file finally has somewhere to put its
  cleanup, without writing that cleanup into the step itself (which would
  make the feature file name something that is not an acceptance
  condition). `defineFixtures`, exported from the `nukadoko` package, keeps
  a fixture map fully typed under `strict`: a plain `export const fixtures =
  {...}` loses TypeScript's own contextual typing the moment it leaves an
  inline call and fails to compile with implicit `any`. A fixture may depend
  on a builtin, on another fixture, or override a builtin outright (`page:
  async ({ page }, use) => {...}` reads `page` as the builtin underneath it,
  never as itself); `auto: true`, Playwright's own "build this even if
  nothing asked for it" option, is refused outright, with a message naming
  why. Two scopes exist: `scenario` (default, rebuilt per scenario or per
  `nuka do` execution) and `process` (built once for the whole `nuka run`
  invocation, the first time any step names it, reused after that); there is
  no `worker` scope, since nukadoko has no parallel execution yet for that
  name to mean anything different from `process`. `process` names one
  address space, not one `nuka run` invocation: the two happen to coincide
  today, but that is not a guarantee, and something that must happen exactly
  once in the world (seeding a database, running a migration, starting a
  mock server that owns a port) does not belong in a `process`-scope
  fixture. Teardown runs in reverse build order regardless of whether the
  step passed or failed, and `use()`'s own return value (`"passed"` or
  `"failed"`) is how a fixture learns which, so it can decide for itself
  whether to keep or discard what it built (a QA team's standard "keep the
  failed one to inspect, destroy the passed one" now has somewhere to
  live). A teardown failure never changes a step's or scenario's own
  status; it lands on the scenario record's new `teardown_errors` (a
  `scenario`-scope fixture) or on stderr (a `process`-scope fixture, torn
  down once with no single scenario record to carry it), and `nuka
  run`/`nuka do` announce it either way without touching the exit code.
  Setup and teardown each get their own timeout (`config.fixtureTimeout`,
  default 60 seconds, overridable per fixture), and a fixture that forgets
  to call `use()`, or calls it twice, is detected and thrown by name rather
  than left to hang the run forever. `nuka check` gains three findings, all
  decided without running a fixture: `fixture-cycle`, `fixture-scope-
  violation` (a `process`-scope fixture depending on a `scenario`-scope
  one), and `page-override-unowned` (a `page` override that owns neither `page`
  nor `context`). `nuka tend` gains two more, both a fact rather than a
  verdict: `fixture-unused` and `fixture-touches-app` (a fixture that
  reaches `page`/`context`, the standing answer to a fixture quietly logging
  a user in before any step asks for it). A receipt now carries `fixtures`,
  one entry per `config.fixtures` entry that step's own bag actually
  touched, `reused: true` telling "already built" apart from "built in
  0ms". `nuka steps --json`'s `needs_browser` now closes over this same
  graph: a step that only destructures a fixture which itself reaches
  `page` reads `needs_browser: true` too.

- **`ctx.page()` can launch firefox or webkit now, not only chromium.**
  `nukadoko.config.ts` gains `browserType` (`"chromium"` by default,
  `"firefox"`, or `"webkit"`), a separate key from `browser` rather than a
  field inside it: `LaunchOptions` (`browser`'s own type) has no key that
  selects an engine at all, so mixing one in would accept something that
  type has no room for. A project that never sets `browserType` launches
  exactly what it always has. Firefox and webkit each still need their own
  binary installed (`npx playwright install firefox`/`webkit`); a missing
  one surfaces as Playwright's own error at launch time, unmodified. Every
  scenario record now also carries `browser: { type, version }`, read from
  the real `Browser` object a run actually launched, never from
  `config.browserType` itself, since a step can override the `page` fixture
  with a different browser than config declared. Absent for a scenario
  whose run never launched a browser at all, the same convention
  `evidence.trace` already follows.

- **A step can now add its own evidence, not only what the harness collects
  on its own.** Two personas asked for this independently: an API response
  body, a DB state snapshot, a generated file's contents, none of which had
  anywhere to go before, short of logging to `console.log` and losing it, or
  a step writing to disk on its own with no place on the receipt to point
  at. `evidence.attach(name, body)` writes `body` (`string | Uint8Array`)
  into the step's own evidence directory and lists it on the receipt's new
  `evidence.attachments`, `{ name, file, at }`; calling it twice with the
  same `name` keeps both files, never overwriting the first. `evidence.path
  (name)` is Playwright's own `testInfo.outputPath()`: it allocates a
  collision-free absolute path without writing anything, and only a path a
  step actually wrote to by the time execution ends lands on the receipt, so
  book-keeping a call was made is never mistaken for evidence that a file
  exists. A `name` containing a path separator, or equal to `.`/`..`/the
  empty string, is refused outright rather than silently rewritten. Capped
  at 100 entries per execution, sorted by `at`; the true total, once that
  cap is hit, reports through the same sibling `truncated` field
  `truncated.actions` already uses, now `truncated.evidence` alongside it.
  The Allure emitter attaches each one the same way it already attaches
  trace/screenshots/http, contentType guessed from the file's own
  extension, `application/octet-stream` when it cannot be.

- **Step discovery reads `.js` and `.mjs` step files, not just `.ts` and
  `.mts`.** A suite whose glue is plain JavaScript, cucumber-js's own
  official ESM sample among them, used to be entirely invisible to
  discovery: an empty vocabulary and every scenario reporting `undefined
  step`, with nothing saying why the vocabulary came back empty. `nuka
  check` now also says why in two new findings:
  `step-file-unsupported-extension`, naming a `.cjs` file discovery walks
  but never imports (`.cjs` is CommonJS regardless of `package.json`'s own
  `"type"`, and nukadoko is ESM-only, an already-documented go/no-go), and
  `no-step-files-found`, naming the directory a walk that found nothing
  loadable actually scanned.

### Changed

- **`evidence.trace` is a step's own trace now, not the whole scenario's.**
  A Playwright trace used to be one file spanning a scenario's whole shared
  browser context, living in the scenario's own directory rather than on any
  one step. It is cut at every step boundary instead: a step that never
  calls `ctx.page()` gets no trace of its own, and a step that does gets one
  holding only what it did, in that step's own receipt directory. Opening
  the trace for the step that actually failed is faster than scrubbing a
  whole scenario's recording for the moment things went wrong, which is the
  whole reason for the change. The scenario record's own `evidence.trace`
  is gone with it: what a single scenario-long trace also gave for free, a
  network view spanning every step at once, a step-scoped trace does not.
  Each step's own trace still shows that step's own requests in full;
  `ctx.request()` traffic keeps its own record in http.jsonl, and (see
  below) page-issued traffic now shares that same file. A Before/After/
  AfterStep hook that touched the browser used to fall through this cut
  entirely: its own `ctx.page()` calls landed in no chunk at all, since a
  chunk only ever opened for a step's own boundary. Every individual hook
  invocation now gets the same treatment a step does, its own isolated
  trace and `actions`, recorded on that invocation's own entry in the
  scenario record's `hooks` array (`trace`, relative to the scenario's own
  directory, since a hook has no receipt dir of its own) rather than
  disappearing the way it used to. The Allure emitter attaches a hook's
  trace to that hook's own fixture and merges its `actions` into that same
  fixture's child-step timeline, matching what a step already gets.

- **A typed step's `run` takes a fixture bag now, not `ctx`.** `run(ctx, args)`
  becomes `run({ page, section }, args)`: only the names a step actually
  destructures ever get built, so a step naming neither `page` nor `context`
  never launches a browser, a fact `check` can now read from the source
  text itself, before anything runs. To migrate a step, collect every
  `ctx.foo` it reads into that first destructured argument, then drop the
  `await` in front of `ctx.page()`/`ctx.request()` along with the call
  parentheses; `page` and `request` are values now, not functions. A
  destructured fixture with a default value or a rest property (`{ page =
  null }`, `{ ...rest }`) is refused, with its own message, since neither
  can be read statically; name every fixture a step needs explicitly
  instead. No codemod ships for this: the reader here is an agent, and a
  mechanical rewrite across a whole `features/steps/` tree is exactly the
  kind of batch edit an agent already does well.

- **A sign-off is now scoped to a condition, not just a feature and a
  commit.** "Chromium accepted, firefox not yet" is a normal state: the
  condition, `(environment, browser)`, is read off what a run actually
  measured, never a declaration, so `nuka accept` now selects among runs
  whose own measured `browser.type` matches the current `config.
  browserType`, and a run that never launched a browser at all stays a
  candidate no matter what `browserType` currently says, since an
  unmeasured axis was never part of what that run confirmed. This is the
  breaking part: the record's own filename now carries the condition too,
  `<feature-basename>.<date>-<sha>.<environment>.<browser>.md` in place of
  the old `<feature-basename>.<date>-<sha>.md` (`<browser>` reads
  `no-browser` for a run that launched none; never a version, which stays
  in the record body only), so two conditions never collide and silently
  overwrite one another. A record's own body gains a "Condition" section
  stating both, explicitly, even when no browser was launched. When no
  run matches the current condition, the refusal now says so and lists
  which conditions do have a green full run, instead of reading as "no run
  exists" when one does, just under a different condition. `nuka tend`
  gains one more note, `signoff-condition-mismatch`: the most recent
  sign-off for a feature naming a browser the current config no longer
  declares, never an error, since nothing about it is wrong yet. A record
  accepted before this shipped carries no condition at all; `nuka tend`
  reads it fine and leaves it out of this one note rather than guessing.

### Fixed

- **Step discovery no longer walks `node_modules` or imports a `.d.ts`
  file.** A project with `featuresDir` set to something wide (a repository
  root, for instance, a real configuration observed in the wild) had
  discovery recurse into every dependency's own files under
  `node_modules`, type declarations included, trying to import each one as
  though it were a step definition. `node_modules` and any dot-directory
  (`.git`, `.nukadoko`, an editor's own `.vscode`, ...) are now skipped at
  every depth, and `.d.ts`/`.d.mts` files are excluded outright.

## 0.0.5 — 2026-08-05

### Changed

- **`nuka do --args` is optional once `--use` is given.** A step whose every
  argument arrives via `from` used to still demand `--args '{}'` on the
  command line: ritual, not a real requirement, once `--use` already says
  "arguments come from the chain". `--args` stays required the rest of the
  time: the exemption only fires when `--use` is present, so a bare `nuka do
  <step>` (neither flag, likely a typo) still fails fast with a message
  naming both flags instead of parsing and only failing later at args
  validation.
- **`nuka tend`'s summary is three lines, not two.** A `scanned:` line comes
  first, naming every directory that run actually looked at (a finding that
  turns out to be wrong is unreadable without knowing what produced it), and
  the `bed:` line now also counts read-only typed steps. Both lines are
  summary, not findings: neither affects the exit code. Called out here
  rather than filed under Added because anything counting `nuka tend`'s text
  output breaks on it; `--json` carries the same fields and does not shift
  under you.
- **`poll` moved onto `ctx`, and now leaves a record.** `import { poll }
  from "nukadoko"` is gone; the same loop is `ctx.poll(fn, options)`, and
  every completed call lands on the receipt's `polls` with how many
  attempts it took, how long it waited, and whether it resolved, timed out,
  or threw. It was an import because it needed nothing the executor owned,
  which was true and was the wrong thing to optimize for: a wait that
  leaves no trace cannot be told apart, afterwards, from one that returned
  on its first attempt. Those two situations call for opposite fixes.
  One attempt at 0ms says the condition was already true and the wait was a
  no-op, so whatever is late is something else entirely; forty attempts
  over 20s says that condition really was the late one. From outside the
  step the two look the same, which is exactly when a receipt is supposed
  to be the thing that answers. Recording it means writing into a collector
  the executor owns and resets at each step boundary, and that is what puts
  it on `ctx`: the same route `ctx.section` took, for the same reason,
  after the same mistake. A timed-out poll is recorded like any other: the
  receipt of the step that failed on that timeout is precisely where the
  numbers are wanted. Migration is mechanical: drop the import, call
  `ctx.poll` instead.
- **A browser step's evidence is one screenshot, not two.** The former
  `finalize(status)` took a screenshot once and wrote the same buffer to
  both `final.png` and, on a failed run, a second time under a second name.
  That second file carried zero additional information, since
  `receipt.status` already answers "did this fail". Worse, because that
  screenshot only ever runs after `run` has already returned or thrown, the
  second copy could be taken seconds after the failure it was named for,
  showing a page that had since changed: `status: "failed"` sitting next to
  a screenshot that looked fine, an apparent contradiction with no fix but
  to distrust one of the two. A real run once measured that gap at roughly
  eight seconds, misdiagnosed as the state itself flickering. `finalize`'s
  and `dispose`'s own `status` argument is gone with it: it had no
  remaining use once the second file did.
- **`evidence.screenshots` entries are `{ file, at }`, not bare file
  names.** `at` is the ISO 8601 moment the screenshot actually resolved (the
  same format `started_at`/`finished_at` already use): the fact a second
  screenshot file used to exist to paper over without ever stating it. A
  screenshot's own timestamp is now on the receipt directly, so a reader
  does not have to guess how stale it might be relative to the step's own
  `finished_at`.
- **`sections` entries are `{ label, at }`, and `polls` gained `at`.** A
  label used to say only that execution reached a stage, never when. "When"
  turned out to matter: a receipt can carry a `status: "failed"` next
  to a screenshot that looks unaffected, and without a shared timeline there
  was no way to tell a real state change apart from a read taken before the
  state settled. `sections`' `at` and `polls`' new `at` (alongside
  `waited_ms`) put every stage and every wait on the same absolute timeline
  `started_at`/`finished_at`/`evidence.screenshots[].at` already use, so
  that question has an answer from the receipt alone.
- **User-facing strings across the CLI no longer use an em-dash.** Forty of
  them changed: `nuka check` and `nuka tend`'s finding messages, `nuka
  accept`'s refusal text, and other strings the CLI prints straight to a
  reader trying to find out what went wrong. `nuka accept` alone had eight,
  more than any other command, since every one of its messages is a reason
  someone cannot do the thing they just tried. Anything that greps one of
  these strings for an exact match is affected: 0.x never made the wording
  a contract, but the wording did move, and that is worth recording here.
  The information itself did not shrink: most of the forty became two
  sentences in place of a comma, so a reader gets the same facts, just
  differently punctuated.

### Added

- **`additionalFeatureDirs` config, and a wider static scan.** A step's
  pattern is bound or unbound as a property of the whole project, not just
  of what an unattended `nuka run` would execute today. So an acceptance
  feature, recommended to live outside `featuresDir` precisely so it never
  runs as a regression, made `nuka check`/`nuka tend` report its steps
  `pattern-unbound` even though they genuinely bind. `additionalFeatureDirs`
  (default `[]`) names directories `nuka check` (no argument) and `nuka
  tend` scan in addition to `featuresDir`, without ever executing them.
  `nuka run` still reads `featuresDir` alone. Two findings come with it: a
  configured `additionalFeatureDirs` entry that does not exist
  (`additional-feature-dir-missing`, an error on `check`, a note on `tend`)
  and an accepted feature outside every scanned directory
  (`signed-feature-unscanned`, a `tend` note: deliberately never used to
  widen the scanned set itself, since that would only ever notice a
  feature already accepted at least once, silently missing the one still
  being drafted).
- **A failed step's receipt carries the upstream values it read.** Each
  `used` entry on a failed step's receipt now also carries `result`: the
  full validated result of the receipt it cites, not only the id and step
  name. Diagnosing a failure used to mean opening a second receipt.json for
  every upstream step a `from` or `resultOf` read from; now the one
  receipt that failed already has it. Present only on a failed receipt (an
  `ok` receipt's own `result` already holds whatever value mattered, so
  repeating an upstream one there would be redundant), and carries the
  whole result rather than the one key that was actually read, since a
  diagnosis needs why the value came out that way, not which key was
  cited.
- **`nuka run <feature>:<line>` says that it is a partial run.** Running one
  scenario is the iteration path and is worth taking: a feature's full run
  costs every scenario's minutes. What it is not is a smaller version of the
  same thing: a partial run can never be signed off, so a green one is a
  debugging result. That was already true and was discoverable only at the
  end, when `nuka accept` refused a road that had been chosen several runs
  earlier. It is now said where the line number is given, on stderr, leaving
  stdout's one-record-per-line contract untouched.
- **`nuka accept`'s refusals name what they were decided from.** A run that
  was red, or a feature that only ever had partial runs, now come back with
  the run in question: its id, when it started, and which of its scenarios
  failed, or which lines the most recent partial run covered. The refusal
  reasons themselves are unchanged; what changed is that the next command
  can be chosen against the record instead of guessed at, which is what the
  git-state refusals in the same command already did.
- **`nuka scaffold`'s template stops framing `returns` as "what later steps
  cite".** That framing is the one a first reader adopts, and it drops every
  value the step's own correctness depends on but nothing downstream reads:
  the date it computed, the id it picked, the name it resolved before
  sending. Those are exactly the values a receipt gets interrogated for once
  a run has gone wrong. A step that sends a date nothing cites, computed in
  the wrong timezone, leaves a receipt that cannot say which date it sent.

## 0.0.4 — 2026-08-04

### Added

- **`nuka tend`, for what is rotting rather than what is broken.**
  `nuka check` answers whether a project can run right now, and everything
  it prints stands between the project and a green run — which is what
  makes its output worth reading, and why findings nobody has to act on
  today do not belong there. Printed before every run, they would train
  people to skim past the line that did have to be acted on. `tend`
  answers the other question, read at a different moment: is this
  vocabulary, and the record it produced, still healthy.
  One finding is an error and exits non-zero — a sign-off that no longer
  matches the code it froze: a frozen `result` that no longer passes its
  step's current `returns` schema, a frozen feature source that no longer
  matches the file, a cited step gone from the vocabulary, or a record that
  cannot be read at all. A record that has quietly stopped meaning what it
  says is worse than no record, because it is still being counted.
  Five are notes a project is allowed to carry: a `from` no occurrence
  exercises, a patterned step no feature binds, a schema field with no
  `.describe()`, a step with no `rationale`, a configured parameter type no
  pattern uses. The middle two are aimed at the agent rather than the
  reader — `nuka describe` is how an agent learns what a field means and
  whether it may rewrite a step, and both go quiet when those are missing.
  Findings state facts and never instruct: a `from` no feature exercises
  may still be reached through `nuka do --use`, so the note says what is
  true and leaves the decision where it belongs.
  It opens with where the bed is — how much of the vocabulary is typed
  rather than still compat, and how much of what a step could declare is
  declared. That is not a finding and does not touch the exit code; a suite
  mid-migration is in a normal state. It exists because the information was
  already there and unread: a receipt's `world` and `declared` counts do
  shrink as a suite promotes, which is true and useless as a way for a
  person to see progress. `--json` names the compat steps rather than
  counting them, since what reads it is assembling work.
- **`from` on `defineStep`, and the binding-order check it buys.** Passing a
  value from one step to the next had exactly one shape: declare the args key
  optional, and fall back to `ctx.resultOf` inside `run`. That worked, and
  cost three things — boilerplate per dependency, an `args` schema that
  called a key optional when the step actually required it, and a dependency
  no tool could read, so a scenario binding the consumer before the producer
  was indistinguishable from a correct one until minutes of real browser time
  had been spent on it. `from: { projectId: [createProject, "id"] }` states
  the same fact as data: this args key is the `id` of whatever that step
  returned earlier in this scenario. A pattern capture still wins, the value
  is filled in before args validation — so the key stays *required* and the
  schema goes back to describing what the step demands — and `nuka check`,
  plus `nuka run` before it executes a scenario, verifies the producer
  actually appears earlier in the same pickle, Background included. A
  required key with neither capture nor producer is an error, since that run
  could only fail args validation anyway; an optional one is silent, because
  the schema already said the value may be absent and warning about a
  contract being honored is noise. A key name, never a selector function:
  a name survives into `nuka steps --json` and `nuka describe` as
  "`projectId` ← `createProject.id`", which is what lets an agent assemble
  an order nobody told it, and what `check` reads.
  A key may list several mutually exclusive producers —
  `[[createProject, "id"], [importProject, "projectId"]]` — for a value
  reachable two ways, so the consumer stays one step instead of splitting
  into two. No priority comes with them: no declaration order, no
  most-recent rule reaching across different steps. The check requires that
  exactly one listed producer is bound earlier in the scenario, and two or
  more is an error whether the key is required or optional — a schema gets
  to say a value may be absent, but none asked for "either of these, and
  the feature file cannot tell you which". A scenario that genuinely
  exercises both producers is not describing alternatives at all and gives
  each its own key. `ctx.resultOf` is unchanged and stays for the reads a
  key name cannot express — a value needing reshaping, a read decided at
  run time, a whole result used as one.
- **`nuka do <step> --use <receipt-id>`** (repeatable) supplies a `from` key
  from an earlier execution's result, so a chain assembled by hand across
  several `do` calls no longer means hand-writing JSON from the previous
  receipt. The upstream step's name is not written on the command line
  because the receipt already carries it: nukadoko reads which step that
  receipt records, finds the `from` entries pointing at it, and takes the
  named keys out of its stored `result`. `--args` still wins for the same
  key. A receipt whose step no `from` entry names, or whose execution
  failed, is an error rather than a silent no-op — a failed step never
  produced a validated result to read.
- **A `Step` that discovery never registered is now an error rather than a
  permanent `undefined`.** Both `from` and `ctx.resultOf` identify the
  upstream by the `Step` object's own identity, so a step reached through
  `await import()` resolves to a different instance than the one discovery
  registered and matches nothing. That used to be silent: `resultOf` simply
  returned `undefined` forever, with no failure to trace back to the import.
  `from` names its upstream statically, so `nuka check` reports it and
  `run`/`do` refuse to execute the step at all; `resultOf` can only be
  caught at the call, where it now throws and names the dynamic-import
  mistake. A registered step that has not run yet still returns `undefined`
  — that is a state, not a mistake.
- **`required_env` on every receipt.** `ctx.requireEnv()` is the one call
  site the library controls on the way to a required environment variable,
  so the names passed through it are recorded as a measurement rather than
  derived by reading step sources: deduplicated, in first-read order,
  omitted when empty — the same shape `used` and `sections` already have.
  Names only, never values, since a value can be a secret. Recorded before
  a missing key throws, so a run that failed for one still reports what it
  asked for. A step reading `ctx.env[name]` directly leaves no trace: that
  path is a plain object no code here mediates. Nothing reconciles these
  names against anything yet — there is no contract on the nukadoko side to
  reconcile them with, and the shape of one should be decided against what
  actually gets measured rather than ahead of it.
- **`browserContext` and `requestContext` config keys.** `newContext`'s
  options had no way in at all, which left `ignoreHTTPSErrors` unreachable:
  a project behind a self-signed certificate could use neither `ctx.page()`
  nor `ctx.request()`, with no workaround from inside a step. Two keys
  rather than one, because `browser.newContext()` and
  `playwrightRequest.newContext()` take two different option types — even
  an option both accept is not the same type on each side, so one shared
  key would mean hand-writing a union instead of deferring to Playwright's
  own types. `baseURL` and `storageState` are rejected on both, with a
  reason in the error: `config.baseURL` is meant to be the only place a
  base URL is stated, and the session mechanism owns `storageState`.
- **Acceptance records end with a `## Declared vs observed` section.** The
  material for that comparison was always in the record — every receipt it
  embeds carries both `mutates` and `observed` — and nothing performed it,
  so a wrong declaration stayed falsifiable but never falsified. The
  section lists every step that declared `mutates: false` and was measured
  making a write. It states the raw fact and no verdict, because a step
  that reads over POST lands there on every acceptance by design. It never
  refuses: the seven refusal conditions are unchanged. It is present even
  when nothing disagrees, so "compared, found nothing" stays
  distinguishable from "never compared", and compat steps are counted
  separately rather than folded into the clean case.
- **`nuka init` creates `<stateDir>/allure-results/`.** Allure's CLI
  refuses to start against a results directory that does not exist, so
  `allure watch` failed on any project that had not run yet — which
  inverts what `watch` is for, since its whole point is to already be
  running while a run happens. An empty directory is enough for it.

### Changed

- **Three findings moved from `nuka check` to `nuka tend`.**
  `parameter-type-support-origin`, `secrets-public-key-unknown`, and
  `secrets-redact-key-unknown` all describe a run that will succeed, so by
  the line the two commands are split on — is this something to know
  *before* this run — they were on the wrong side. The first is the clearest
  case: it appears for as long as a suite has any compat glue left, which is
  a normal state to be in, and printing it before every run trains people
  past the lines that do stop one. The codes are unchanged, so the move is
  a change of address rather than of vocabulary.
  Their neighbours stay on `check`, and the contrast is the point:
  `secrets-redact-key-too-short` and `tracked-secret-looking-key` both mean
  plaintext reaches a log the moment the run starts, which is exactly
  something to know beforehand. So does `then-compat-step` — a compat step
  in Then position is a live tension about this run, and promoting it is
  only one of the ways to resolve it.
- **A receipt's `used` names the step beside each receipt it cites.** It was
  a bare list of receipt ids, which made an acceptance record unreadable
  without resolving every id against other files — files that are local
  working records under `.nukadoko/`, while a sign-off is meant to outlive
  them. Each entry is now `{ "receipt": "rcpt-…", "step": "create-project" }`.
  The step name is redundant with the cited receipt on purpose: a record
  that has to be joined against something else to be read is a worse record
  than one that is legible alone. Deduplication by receipt id and first-read
  ordering are unchanged, as is omitting the key entirely when nothing was
  read. `used` also now covers every way a value can be drawn from an
  earlier execution — a `from` injection and a `nuka do --use` receipt, not
  only a `ctx.resultOf` call. **This is a breaking change** for anything
  reading `used` out of a receipt or out of the Allure report's "used
  receipts" parameter.
- **`nuka steps`' text output is formatted for a terminal.** It was one
  tab-separated line per step, which real vocabularies push to 120-145
  characters; an 80-column terminal soft-wraps that with no indentation, so
  a reader cannot tell where one step's row ends. Output is now one
  blank-line-separated block per step, wrapped to the terminal's width,
  with continuation lines indented one step deeper. Wrapping happens at
  space boundaries only and a single over-wide word is left unsplit, since
  a pattern is a cucumber-expression or a regex and splitting one mid-word
  makes it uncopyable. **This is a breaking change for anything parsing
  that output** — `--json` is unchanged and is the machine-readable path.

### Fixed

- **`ctx.request()` no longer requires a `baseURL`.** It threw when
  `config.baseURL` was unset while `ctx.page()` on the same ctx passed the
  same undefined value through and worked. Playwright's own
  `request.newContext()` treats it as optional, so the requirement was
  nukadoko's own addition — and a suite talking to several hosts by
  absolute URL has no single baseURL to name, so satisfying it meant
  writing something untrue into the config. A step that passes a relative
  path with no baseURL configured now fails on Playwright's own call.

### Documentation

- How to actually view the report: `allure watch` (live — it re-renders as
  a run writes), `generate`, and `open`, verified against this repository's
  own results. Every command passes `--output .nukadoko/allure-report`,
  because Allure defaults that to the current directory and would otherwise
  leave a generated report in the repository root, un-ignored.
- Upgrading before 0.1 needs `npm install -D nukadoko@latest`: npm writes
  `^0.0.x`, and a caret pins the patch there, so `npm update` never moves
  off the first installed version.
- The secrets rule — git classifies env files, untracked means secret
  source, tracked means plain configuration — now appears in the README
  rather than only in the spec.
- How a step stays runnable under `nuka do` and still chains in a scenario:
  an optional argument with a `ctx.resultOf` fallback, plus the rule that
  makes it work (a schema key with no capture must be optional, and
  `nuka check` does not catch a required one).
- The spec now states that nukadoko never reconciles `mutates` against
  `observed` itself, and why automating that claim is not on the table.
- README.ja.md glosses each English heading in Japanese.

## 0.0.3 — 2026-08-03

### Changed

- **`mutates` is now a declaration nukadoko trusts, not a verdict it derives
  from measurement.** A Then-position step that observes a network write no
  longer fails, and neither does one that writes under a `read-only`
  environment. Write detection runs on HTTP method, which is a proxy for
  write semantics rather than the semantics itself: GraphQL, RPC-over-POST,
  and most vendors' query endpoints implement pure reads over POST, so a
  truthful `mutates: false` step calling one was counted as writing, barred
  from `Then`, and unusable read-only — with no escape hatch. The
  distinguishing signal is protocol-specific every time and invisible from
  the HTTP layer, so there is no general rule to widen the proxy with.
  Everything is still recorded: `observed` remains on every receipt, beside
  `mutates` in the Allure table, with every call in `http.jsonl`. A wrong
  declaration stays falsifiable after the fact, which is why trusting it is
  not the same as abandoning measurement.
- Declaration-based gates are unchanged: a `read-only` environment still
  refuses a declared mutator before it runs, and `nuka check` still warns
  when one is bound in `Then` position.

### Removed

- `then_mutated` and `read_only_violation` are gone from `ErrorKind`. Nothing
  assigns them any more, and a closed vocabulary that lists unreachable
  values is a lie about what a receipt can say. `categories.json` and the
  bundled `allurerc.mjs` ship seven rules instead of nine.

### Added

- `rationale` on `defineStep`: why a step is implemented the way it is, and
  what was rejected. Shown by `nuka describe`, never in `nuka steps`' listing
  (which stays one line per step), and never on a receipt (it describes the
  contract, not an execution).
- `ctx.requireEnv(name)` returns `string` by throwing when a variable is
  unset or empty, so a step reading a required value stops writing its own
  presence check — and stops phrasing the failure differently in every
  project, which matters when agents are the ones reading it.
- `ctx.section(label)` marks a stage inside a step; the receipt carries
  `sections`, the labels in call order. A failed step's array ends at the
  last stage it entered, so a long step finally says where it stopped.
- `nuka init --features-dir <dir>` for a project that doesn't use the
  default layout, writing `featuresDir` into the generated config as well as
  creating the directory.
- `nuka check` reports a glue file it cannot import (`step-file-import-failed`,
  carrying Node's own message) and keeps checking the rest of the project,
  instead of dying on the first one. It also reports unsupported hook tag
  expressions. A migrating suite's normal state is "some glue is still
  broken", which is exactly when a migration dashboard has to keep working.
  The undefined-step errors that a missing file's vocabulary would cause are
  suppressed while any import failed, with a warning saying how many were
  held back.
- `config.browser` takes Playwright's own `LaunchOptions` and passes it to
  `chromium.launch`. It was `unknown` before, with only `headless` read out
  of it, so anything else written there was silently ignored.
- `nukadoko/compat` exports `Status`, `AfterStep`, `IWorldOptions`, and
  `ITestCaseHookParameter` — every remaining name the compat audit counted
  except `setParallelCanAssign`, which stays unsupported by decision:
  nukadoko has no parallel execution, so accepting the call would leave a
  suite believing a rule was in force while nothing enforced it. `AfterStep`
  runs once per executed step (never for a step that was skipped) and its
  record entry carries `step_index`.

### Fixed

- `poll`'s signature said `fn` and `poll` returned the same type, while the
  implementation treats `undefined` as "not ready yet". Passing
  `() => Promise<Job | undefined>` therefore typed `poll` as possibly
  returning `undefined`, which it cannot do, and callers under `strict` had
  to assert it away. Only the parameter type changed; the body is untouched.
- `nuka check`'s `parameter-type-support-origin` reported an absolute path in
  `file` where every other issue reports one relative to the project root.

### Packaging

- `docs/` ships in the tarball. The README and the migration guide both link
  to `docs/spec.md` relatively, and from an installed copy those resolved to
  nothing — which undercut the one thing this package says about itself,
  that the design and its limits live in a single place you can reach.
  `examples/` stays out (316K, and it carries generated artifacts); links to
  it are absolute now.

## 0.0.2 — 2026-08-03

### Fixed

- `nuka --version` printed the version of whichever project was running the
  CLI rather than nukadoko's own. yargs was never told a version, so its
  default resolution walked up from the current working directory: a
  consumer whose package.json said `9.9.9` got `9.9.9`, and one with no
  version field got `unknown`. It now reads this package's own
  package.json, resolved from the module's own location.

### Added

- The cucumber-messages `meta` envelope carries `implementation.version`.
  It was omitted in 0.0.1 only because nothing here could read the
  package's own version at runtime, which is the same gap the fix above
  closed.

## 0.0.1 — 2026-08-03

First published version. Covered by 523 tests.

### Typed steps

- `defineStep` with zod schemas for `args` and `returns`, validated at the
  run boundary, and named capture (`{name:string}`) so reordering two
  same-typed values in a pattern cannot silently swap them.
- `ctx.resultOf(step)` reads a previous step's validated result by the Step
  object's identity rather than by name, which makes the dependency a static
  import as well as a receipt entry.
- `mutates` is declared per step and checked against what the run observed:
  a Then-position step that writes fails on the measurement, not on the
  declaration.

### Receipts

- Every execution writes a receipt: the validated result, the network reads
  and writes the tool itself observed, evidence, environment, and target
  version.
- `nuka accept` freezes one green run as a committed record beside its
  feature. Execution and sign-off stay separate commands; failing runs are
  not recorded.

### Running

- `nuka init`, `scaffold`, `steps`, `describe`, `do`, `check`, `run`,
  `accept`, `session`, and `skill path`. Every command has a `--json` form
  or machine-readable output where it makes sense.
- `nuka check` reports duplicate patterns, ambiguous steps, undefined steps,
  and bare `{string}` captures before anything runs.
- Sessions, environments (`--env`), and secrets loaded from configured env
  files.

### Compat

- `nukadoko/compat` runs an existing cucumber-js suite by switching one
  import, keeping pattern syntax, hooks, and the World working while
  receipts are measured underneath. Switching the import back returns a
  plain cucumber-js suite.
- ESM only: `require("nukadoko/compat")` fails outright, so a CommonJS suite
  needs a module-format change first.

### Reports

- Allure emitter, filling the report from receipts with no per-project hook
  wiring, including the validated per-step result that classic Cucumber
  discards.
- cucumber-messages (NDJSON) emitter, so existing formatters and JUnit-based
  CI keep working.

### Skills

- Two skills following the [Agent Skills specification](https://agentskills.io/specification):
  `acceptance` (a ticket's criteria through to a committed record) and
  `migration` (moving a cucumber-js suite across in two stages). Neither
  writes down what the CLI can answer.

### Not in this release

Compat gap detection in `nuka check`, an AI-assisted glue converter, and
scenario harvesting. See the [roadmap](docs/spec.md#roadmap).
