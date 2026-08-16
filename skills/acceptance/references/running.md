# Running and accepting

## Before running

`nuka check <feature>` catches every static inconsistency it can, before
anything executes. Among them: a step whose `from` key has no producing
step earlier in that scenario, or has two of them competing. That one
otherwise costs a whole browser session to discover, since the scenario
looks correct until the consuming step actually runs.

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
