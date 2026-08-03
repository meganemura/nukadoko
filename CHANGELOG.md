# Changelog

Notable changes to nukadoko. Versions follow [Semantic Versioning](https://semver.org/),
with one caveat stated in the README: this is pre-0.1, so the public API can
change without a major bump until 0.1.

## Unreleased

### Added

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
