# Running and accepting

## Environments

`--env <name>` on `nuka do`, `nuka run`, and `nuka session start`/`stop`/
`clear` targets one of the environments named in `nukadoko.config.ts`'s
own `environments` key; omitting it targets `default`, which needs no
entry there. Each entry can override `baseURL`, append its own `envFiles`
after the top-level list, and set `policy: "read-only"`.

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
step earlier in that scenario, or has two of them competing. That one
otherwise costs a whole browser session to discover, since the scenario
looks correct until the consuming step actually runs. `nuka check --codes`
names every finding code `check` can produce; read it there rather than
from a list kept anywhere else.

If the feature's directory is in `additionalFeatureDirs` (see "What not to
do" in `SKILL.md`), a bare `nuka check` already covers it, the same as any
feature under `featuresDir`. Otherwise pass the feature path directly:
`nuka check <feature>` checks that one file, since without either the
argument or the config entry the one file you care about is the one that
goes unchecked.

## Running

1. Commit. Anything the run reads has to be in a commit first, including
   any step files written along the way. Records a previous `nuka accept`
   wrote are the exception, so a second feature from the same run needs no
   commit in between.
2. `nuka run <feature>`, repeat until every scenario is green. stderr
   prints a boundary line per scenario, one line per step as it finishes,
   and, once the run ends, every path it actually wrote plus a summary
   line; `--quiet` drops the progress lines when the terminal gets noisy.
   stdout stays NDJSON, one scenario record per line, unaffected either
   way. When a scenario fails, diagnose it before repeating the whole run
   (see `references/diagnosing.md`) rather than treating a full re-run as
   the default first move. `<feature>:<line>` is fine for narrowing this
   while iterating, but the run this step ends on must cover the whole
   feature: `accept` never treats a partial run as a candidate, however
   green it was.

## Accepting

`nuka accept <feature>` freezes the newest all-green run of that feature as
a record beside it, restricted to runs matching the current condition:
`--env` (resolved the same way `nuka run`'s is; omit for the default
environment) and whatever `config.browserType` says right now, both
matched against what each candidate run actually measured, never a
declaration. A run that never opened a browser is a candidate regardless of
`browserType` (there is no `--browserType` flag on `accept`, since it is
fully config-derived). Every record's filename bakes its own condition in
(environment, then browser or `no-browser`), so accepting this feature
again later under a different measured condition writes a separate record
instead of overwriting this one; when two runs differ only by environment,
`--env` is what picks which one gets frozen. On success, stderr also asks
the placement question from "What not to do" in `SKILL.md`; stdout stays
exactly the record's own path.

Commit the record `accept` wrote.

## What a run writes

Every `nuka run` also writes two report streams, both with zero
configuration and no flag to turn either on: Allure results under
`.nukadoko/export/allure-results/`, and a cucumber-messages NDJSON stream
under `.nukadoko/export/messages.ndjson`. `allure.resultsDir` and
`messages.output` in `nukadoko.config.ts` only relocate where each writes;
neither ever needs enabling. `nuka run`'s own stderr names every path it
actually wrote at the end of the run, so where output landed is never a
guess.

Open the two for different reasons. Allure is nukadoko's own dashboard:
every step's trace, HTTP log, and validated result, plus a per-step
timeline of what it waited for and what it clicked, all in one place with
zero project wiring. Render it with Allure's own CLI. During iteration,
`npx allure watch <dir> --output <report-dir>` reads temporary scenario
snapshots that arrive after each completed step. Use `npx allure generate`
and `npx allure open` for a completed run. Nukadoko never renders HTML
itself. `messages.ndjson` is for the
opposite reason: feeding a suite's existing cucumber-js-era formatter or
JUnit-based CI while it migrates, not for reading by hand.

`messages.ndjson` at the configured path is not that run's own stream
while the run is happening; it is a copy of the most recently *completed*
run, replaced atomically once a run's own `end()` runs. Each invocation
writes its own stream first, to a run-id-suffixed file beside the
configured path (`messages.<run_id>.ndjson`), so tailing the configured
path to watch a run live shows nothing until that run finishes; use
`npx allure watch` for a live view instead. Each of those per-run files
stays on disk for as long as its run does: `nuka run` keeps the newest
`retention.runs` runs (default 20) and removes older ones, records and
export files alike, at the end of every run, printing one `retention:`
line when it did. `nuka clean [--export]` removes all of them at once
along with the configured path's own copy.
