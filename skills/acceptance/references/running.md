# Running

## Setting up

Run every `nuka` command from the directory that holds the config; in a
workspace, that is the package, not the root. When there is no config,
`nuka init` writes it, `features/steps/`, `.gitignore` lines for
`.nukadoko/` and `.env` files, and a `test:scenarios` script in
`package.json`, so `npm run test:scenarios` runs `nuka run`, which checks
`featuresDir` and then executes it. A
`test:scenarios` script the project already has stays, and `init` says so
on stderr; run `nuka run` directly then. It also adds the steps and the
config to `tsconfig.json`'s `include`, and
`"rewriteRelativeImportExtensions": true` to its `compilerOptions` so
`tsc` accepts the `.ts` import names `nuka scaffold` writes, keeping its
comments and trailing commas. When `compilerOptions` comes only through
`extends`, `init` says on stderr what to add instead of editing.

For an HTTP API, `nuka init --server "node src/server.ts" --server-url
http://127.0.0.1:3000` also writes `baseURL` and a `server` fixture that
starts the command with `runServer` for each scenario that sends a request
(`nuka scaffold --request`), so no fixture is written by hand. The
program has to listen at that URL on its own; `runServer` waits for the
port and fails by name when the program exits first, never listens, or
finds the port already taken. Install `playwright` when init says so.

A CommonJS project (no `"type": "module"` in `package.json`) gets
`nukadoko.config.mts`, and step files need `.mts` too. A hand-written
`nukadoko.config.ts` there loads with a Node warning on every run (`nuka
tend` reports it as `package-type-missing`), and fails to import under
`"type": "commonjs"`, with an error that names the file.

A flag that takes one string or one number is refused when it is given
more than once, and the command writes nothing. `--use`, `--fail-on`, and
`nuka run`'s `--env` repeat. Each value is kept, in the order given.

## Environments

`--env <name>` on `nuka do` and `nuka run`
targets one of the environments named in `nukadoko.config.ts`'s
own `environments` key; omitting it targets `default`, which needs no
entry there. Each entry can override `baseURL`, append its own `envFiles`
after the top-level list, and set `policy: "read-only"`. `nuka run --env
a --env b` runs every selected scenario in `a`, then in `b`, as one run:
`verdicts` and the summary hold one cell per scenario and environment, a
failure's `do:` names its environment, and any red cell makes the run red.
A cell that reads `not run` never ran: the `hook-failed` finding beside
it names the environment whose BeforeAll stopped it.

Trial and error, `nuka do` while building a step and `nuka run` while
getting a feature green, belongs on a verification environment; never
point `--env` at a production-pointing name. `policy: "read-only"` is a
second backstop for exactly that mistake, not a substitute for picking the
right environment in the first place: it refuses a `mutates: true` step
outright before that step ever runs, and the same refusal reaches a
`mutates: true` part a step calls, whatever that calling step declared
about itself.

## Before running

`nuka check <feature>` catches every static inconsistency it can, before
anything executes. Among them: a step whose `from` key has no producing
step earlier in that scenario, or has two of them competing. That case
otherwise costs a whole browser session to discover, since the scenario
looks correct until the consuming step actually runs. A step whose fixtures build `page`, `context`, `pageAs`, or `request` in a
project that has not installed `playwright` is `playwright-missing`, with
the install line, so the run stops before it starts. A step file that
imports `playwright/test` (or `playwright-core`, `@playwright/test`)
without the package installed is `playwright-missing` too, named at the
step file instead of `step-file-import-failed`; the one install line fixes
every file in the group. A step file that reaches the package through
another project file is the same finding, and the message names that file. A line in a configured env file that is not a blank, a comment, or
a binding is `env-file-skipped-line`. Compat glue that
declares a done() callback is `done-callback-arity`. The finding covers a
hook whose parameter count is past what the executor passes, and a matched
compat step whose function takes more arguments than the line's captures
plus a table or docstring. A `"pending"` or `"skipped"` return is still
only visible to `nuka run`. `nuka check --codes` names every
finding code `check` can produce. Read the catalog there rather than from
a list kept anywhere else.

If the feature's directory is in `additionalFeatureDirs` (see "The loop"
in `SKILL.md`, step 6), a bare `nuka check` already covers it, the same as any
feature under `featuresDir`. Otherwise pass the feature path directly,
since without either the argument or the config entry the one file you care
about is the one that goes unchecked. `nuka check` takes the targets
`nuka run` takes (several files, or a directory) and selects the same
files, so `nuka check <targets>` reports the errors `nuka run <targets>`
would stop on. `:line` belongs to `nuka run`.

The walk that finds those feature files skips `node_modules` and any
directory whose name starts with `.`, at every depth: a `.feature` file
there is not checked and not run, and the skip reports nothing.

## Running

1. Commit before the run you report. The run summary names the commit
   and says whether the tree had uncommitted changes, so a run on a dirty
   tree tells the reviewer it may not match what the pull request holds.
   Debugging against a dirty tree is fine.
2. `nuka run <feature>`, repeat until every scenario is green. It first
   reports what `nuka check` reports for the selected scenarios and exits
   2 before executing anything on an error (a failed scenario exits 1, so
   2 always means nothing ran); `--no-check` skips that check
   to run a scenario `check` refuses. stderr
   prints a boundary line per scenario, one line per step as it finishes,
   and, once the run ends, every path it actually wrote plus a summary
   line. A failed step adds its error's first line and its step record
   path, and each failed scenario gets a `scenario-failed` finding after
   the summary, whose `do:` line reruns it.
   stdout is empty unless you ask: `--records` writes NDJSON there, one
   scenario's `run.json` entry per line, and `run.json` is on disk either
   way. To act on the result, pass `--json` instead: stdout is then
   `run.json` itself, one envelope
   `{ schema_version, nukadoko, command, verdict, findings, ... }` with the
   run's fields beside `findings` (`commit`, `environments`, `selection`,
   counts, `verdicts`, and per scenario its steps with `line`, `status`, `record`, and
   a failed one's `error` and `used`, plus a failed scenario's `do`); the
   run writes the same bytes beside its summary, which is rendered from it. stderr is then empty: every
   warning and failed scenario is a finding in the envelope. Text a step, a hook, or a fixture writes through `console.log` or
   `process.stdout.write` is delivered on stderr, so it does not break
   that stream. A child process spawned with `stdio: "inherit"` still
   writes to stdout directly. The run also
   writes a Markdown run summary for the person reviewing it, to
   `.nukadoko/runs/<run_id>/summary.md` (the `summary` line names
   it), and to `$GITHUB_STEP_SUMMARY` when that is set; `nuka report
   --format markdown --out <path>` writes it again for a CI step that posts
   it as a pull request comment. A compat World
   constructor that throws fails that scenario only: stderr gets one setup
   line, and later scenarios still run.
   There is no step record for that failure. With no target, `nuka run`
   runs `featuresDir`, which is what `npm run test:scenarios` does.
   When a scenario fails, diagnose it before repeating the whole run
   (see `references/diagnosing.md`) rather than treating a full re-run as
   the default first move. `<feature>:<line>` is fine for narrowing this
   while iterating, but the run this step ends on must cover the whole
   feature: a partial run's summary covers only the scenarios it selected,
   and stderr says so.
3. A failure that reproduces one time in several is a case for
   `nuka run <feature>:<line> --repeat <n>`, not for a shell loop: every
   execution lands under one run id, its summary cell counts them, and a
   scenario that failed at least once gets a `repeat` line after the
   failed list, `<passed> of <n> passed`. Read the failing executions'
   records and screenshots (`references/diagnosing.md`) rather than the
   count alone: the count says how often, never why.
4. Once the feature is green, run `nuka run <feature> --probe`. Each
   passed read-only Then runs again with one capture changed; a
   `then-passed-with-changed-capture` note says that Then passed anyway,
   so it may not compare that value. Fix the step's comparison, not the
   feature. A note on "at least {n}" with n+1 is the sentence being true,
   and stays. A `then-probe-not-measured` note says the probe learned
   nothing about that Then, and its message says why. Neither note
   changes the exit code.

## The pull request

Push the feature and its steps and open the pull request. CI runs the
feature and posts the run summary on it (`docs/ci.md` in the nukadoko
package has the workflow); `--since <base>` adds what moved since the
approved base. A person reads the feature and the summary: the run is the
evidence, and the team records the approval where it records approvals.
nukadoko writes or commits nothing else for it. Whether the criteria still hold later
is a question for the next CI run, not for the old summary, and a failed
run that a later run fixed is history the pull request can show.

## What a run writes

`nuka run` writes its records, `run.json`, and the run summary, and no
report. `nuka report` renders a finished run afterwards, from the run
directory alone, so a run directory downloaded from CI renders too:

```sh
nuka report --format allure                        # .nukadoko/export/allure-results/
nuka report --format messages --out messages.ndjson
nuka report --format markdown                      # the run summary, on stdout
nuka report .nukadoko/runs/<run_id> --format allure --out reports/allure
```

With no run directory it renders the newest run. Each command names on
stderr the path it wrote, so where output landed is never a guess.

Open the two report formats for different reasons. Allure is nukadoko's
own dashboard: every step's trace, HTTP log, and validated result, plus a
per-step timeline of what it waited for and what it clicked, all in one
place with zero project wiring. Render it with Allure's own CLI:
`npx allure watch <dir> --output <report-dir>` picks up each render while
you iterate, and `npx allure generate` and `npx allure open` serve a
finished one. Nukadoko never renders HTML itself. The messages stream is
for the opposite reason: feeding a suite's existing cucumber-js-era
formatter or JUnit-based CI while it migrates, not for reading by hand.

Rendering the same run again replaces what its last render wrote under the
state directory. Those files leave with their run: `nuka run` keeps the
newest `retention.runs` runs (default 20) and removes older ones, records
and export files alike, at the end of every run, printing one
`retention:` line when it did. `nuka clean` removes all of them at once. A
report written with `--out` outside the state directory is yours to keep.
