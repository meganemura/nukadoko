# Running nukadoko in CI

A recipe, not a requirement: `nuka check` and `nuka run` are ordinary CLI
commands that exit `0` when everything holds and non-zero the moment
something is wrong (see [README.md](../README.md#running-this-in-ci) and
"CLI summary" in [docs/spec.md](spec.md#cli-summary)), so any CI system can
run them. This page fills in what a two-line excerpt cannot: two whole
workflow files (one job for a CLI or API project, and a browser
project's workflow), why three of their lines exist, and the four things a
project coming from `npx playwright test` usually has to add by hand
that `nuka run` never does on its own.

## A CLI or API project: one job

A project set up with `nuka init` already has `npm run test:scenarios`,
which runs `nuka run`. With no target, `nuka run` runs `featuresDir`, and
before it executes anything it reports what `nuka check` reports for those
scenarios and exits `2` when one is an error, without running anything. A
failed scenario exits `1`. A step in the job that has to tell the two
apart reads `$?`: `2` means fix the invocation or the suite before it can
run (a bad flag, an invalid config, a missing target, a `check` error),
and `1` means it ran and something is red. One job is therefore the
whole gate for a project whose steps never open a browser:

```yaml
jobs:
  scenarios:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 24
      - run: npm ci --ignore-scripts
      - run: npm run test:scenarios
```

`node-version` can be any release nukadoko runs on: 22.18 or later on the
22 line, or 23.6 or later, the releases that load a `.ts` file without a
flag. 24 is the long-term-support line these files use.

Nothing here installs a browser, or Playwright itself: `playwright` is an
optional peer dependency of nukadoko, so `npm ci` brings it in only for a
project that lists it in its own `devDependencies`. A step that needs it in
a project that does not list it stops this job at the check, as
`playwright-missing`, before any scenario runs.

`nuka check` on its own still has two uses: `additionalFeatureDirs`, which
only `nuka check` walks, and a gate that has to stay seconds
long when the run does not. That gate takes the targets the run takes,
files or directories (`npx nuka check features/checkout`), and reports the
errors the run would stop on for them.

## A browser project: a workflow you can copy whole

This is one file, `.github/workflows/nukadoko.yml`. It runs `nuka check` on
every push and pull request (seconds, no browser), `nuka run` after it
passes (the gate that actually executes). With no target, `nuka check`
also prints notes, what is rotting rather than what is broken; they never
fail the job unless `--fail-on` names their code. The two commands sit in
two jobs so a failed check stops the work before a browser
is installed. `nuka run` checks its own scenarios again before it executes,
which costs one more step discovery and no browser.

A browser project lists `playwright` in its own `devDependencies`, at the
version nukadoko is tested against (`npm install -D -E playwright@1.61.1`):
nukadoko declares it as an optional peer dependency and does not install it.
The `npm ci` lines below then bring in the package in every job, and only
the `run` job downloads a browser for it.

```yaml
name: nukadoko

on:
  push:
    branches: [main]
  pull_request:

jobs:
  check:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 24
      - run: npm ci --ignore-scripts
      # PR gate: static, seconds, no browser. Put this on every PR; it can
      # fail before anything runs. Its notes (what is rotting rather than
      # what is broken) leave the exit code alone; add `--fail-on <code>`
      # for each note the team has agreed to gate on.
      - run: npx nuka check

  run:
    needs: check
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 24
      - run: npm ci --ignore-scripts
      # `nuka run` opens a browser; install it here, not on the `check`
      # job above, which never launches one. `chromium` is
      # `browserType`'s own default (docs/spec.md "Environments and
      # secrets"); add `firefox`/`webkit` too if `browserType` names one
      # of them. `--with-deps` is a Linux-runner requirement: without it,
      # Playwright's own browser binary is present but missing the system
      # libraries it needs to actually launch.
      - run: npx playwright install --with-deps chromium
      # No step starts the app under test: `nuka run` builds and starts
      # it from nukadoko.program.ts, on a port of its own, waits until its
      # ready path answers, and stops it after the scenarios
      # (docs/spec.md "Program"). `nuka run` never reads
      # playwright.config.ts, so its `webServer` field starts nothing.
      # Merge/deploy gate: executes, writes step records. Its Markdown
      # run summary appears on this job's summary page by itself, since
      # `nuka run` appends to $GITHUB_STEP_SUMMARY whenever it is set.
      - run: npx nuka run features/
```

## Why the workflow above pins actions, skips install scripts, and limits permissions

In August 2026, several widely used npm packages were compromised. The
attack path started with a `preinstall` hook in `package.json`, which npm
runs automatically the moment `npm install` starts, before anyone running
it has read a line of the package's own code. That hook scanned more than
200 file paths for AWS credentials, GitHub personal access tokens, npm
tokens, and SSH keys, and sent whatever it found to a server outside the
project. With a stolen GitHub token, the same attack went on to inject a
workflow into `.github/workflows/`, one that read every repository
secret with `toJSON(secrets)` and wrote the result into a build artifact.

Three lines in the workflow above answer three parts of that path.

- **`uses:` names a commit, not a tag.** A tag such as `@v4` can move: a
  compromised maintainer account can repoint it to different code
  without changing the string a reader sees in the workflow file. A
  commit SHA cannot move the same way, which is why the workflow above
  names one. The two SHAs above are also each action's newest release as
  of this writing, `checkout` v7.0.1 and `setup-node` v7.0.0, three
  majors ahead of the `v4` tag this file used before; a fresh pin was
  the moment to move onto it. Pinning to a SHA trades away the automatic
  updates a floating tag carries: nothing here moves the pin forward on
  its own. Something has to do that by hand, or with a tool built for
  it; Dependabot can update a SHA pin, and it is one option among
  several, not a requirement of this recipe.
- **`npm ci --ignore-scripts` turns off the hook the attack above used.**
  This repository's own `.npmrc` already sets `ignore-scripts=true`, so
  the effect already holds here without the flag on the CI line. The
  flag is written into the line anyway, because a reader who copies this
  recipe into another project takes the YAML, not this repository's
  `.npmrc`; without the flag in the line itself, that other project
  installs every dependency's scripts by default, the same default the
  attack above relied on.
- **`permissions: contents: read` limits what a token inside the job can
  do.** What a step can do with GitHub's own token is set by the
  `permissions:` block, not decided case by case; job-level `permissions:
  contents: read` scopes that token to reading repository contents, so
  even a step that has already been compromised cannot use it to push a
  commit or write a new workflow file. This repository's own default
  workflow permission is already `read`, and it holds zero repository
  secrets, but a reader who copies this recipe brings the YAML, not this
  repository's account-level settings; a repository with different
  defaults needs the block written into the file itself to hold the same
  line.

## The four things this adds beyond `npx playwright test`

A team arriving with a working Playwright Test CI setup already has most
of the above; these four are what changes.

- **The browser install line names an engine.** On a fresh runner, `npx
  playwright test` gets away with `npx playwright install --with-deps`
  alone, since Playwright itself reads which browser to install from the
  project's own `playwright.config.ts`. nukadoko has no
  `playwright.config.ts` of its own to read that from:
  `browserType` in `nukadoko.config.ts` picks the engine (`"chromium"` by
  default), so the install command above names it explicitly. Firefox and
  webkit each need their own binary too (see "Environments and
  secrets" in [docs/spec.md](spec.md)); add the ones `browserType` (or a
  test matrix across it) actually needs.
- **The app under test starts from `nukadoko.program.ts`, not from
  `webServer`.** `nuka run` and `nuka do` read `playwright.config.ts` for
  nothing at all (see
  [docs/migration-playwright-test.md](migration-playwright-test.md)), so
  its `webServer` field starts nothing. The program file's `build`,
  `prepare`, and `serve` do that job, and a program that does not start
  fails the run with `program-start-failed` and the end of its log, not
  with an `ECONNREFUSED` in the first step that touches `page` or
  `request` (see "Program" in [docs/spec.md](spec.md#program)).
- **What a run leaves behind is bounded, and the rest is not.** `nuka run`
  keeps the newest `retention.runs` runs and removes older ones itself at
  the end of every run (see "Artifacts" in
  [docs/spec.md](spec.md#artifacts)), so on a persistent runner
  `.nukadoko/runs/` and the export output stay the size of that many
  runs. What it never removes is an `allure-results/` directory
  written before nukadoko kept a per-run manifest of its files. A
  GitHub-hosted runner is a fresh virtual machine per job, so it does not
  matter there. A self-hosted or otherwise persistent runner has two
  fixes for it: `rm -rf .nukadoko` at the start of the job, or
  `npx nuka clean` (see its own `--help`), which does the same thing more
  narrowly.

## What a team adds on top

Five things the workflow above leaves to the team, each small.

- **The run summary as a pull request comment.** The job summary page
  already shows it, but a reviewer reads the pull request: the feature in
  the diff and the summary beside it, which is the evidence of what ran at
  that commit. `nuka run --since <base commit>` adds what moved in the
  criteria since the approved base, as far as its comparison reaches
  ("Running" in [docs/spec.md](spec.md#running) says what it compares). The base
  has to be in the checkout, and the commit to name is where the branch
  left it, not wherever the base branch has moved since:

  ```yaml
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
        with:
          fetch-depth: 0 # the base branch and the history merge-base needs
      # ...
      - run: npx nuka run --since "$(git merge-base HEAD origin/${{ github.base_ref }})"
  ```

  `git merge-base` names the commit the branch started from, so a change
  that landed on the base branch afterward is not reported as one this
  pull request reverts. On a `pull_request` event, the checkout is the
  merge commit GitHub made of the branch and the base branch's tip, and
  the merge base of that is the tip itself, so the same line is right for
  it too. A shallow checkout (`fetch-depth: 1`, the default) has no
  history for `merge-base`; with only `git fetch origin <base branch>`,
  name `origin/<base branch>` directly, which is right for the merge
  commit and only for it. Where the approval is recorded, the pull request review or
  anything else, is the team's process; nukadoko records the evidence, not
  the approval (see "Review" in [docs/spec.md](spec.md#review)).
  `nuka report --format markdown --out <path>` writes the same Markdown of
  the newest run to a file, and one more step posts it:

  ```yaml
  # in the `run` job, which then needs `pull-requests: write` beside
  # `contents: read`
  - run: npx nuka run features/
  - run: npx nuka report --format markdown --out nukadoko-summary.md
    if: always()
  - name: Comment the run summary on the pull request
    if: always() && github.event_name == 'pull_request' && hashFiles('nukadoko-summary.md') != ''
    env:
      GH_TOKEN: ${{ github.token }}
    run: >-
      gh pr comment ${{ github.event.pull_request.number }}
      --body-file nukadoko-summary.md --edit-last --create-if-none
  ```

  `if: always()` is there because a red run is the one a reviewer most
  needs to read. `--edit-last` updates the comment an earlier push left
  instead of adding one per push. Every summary starts with the line
  `<!-- nukadoko:run -->`, so a step that posts other comments too can find
  this one by that marker instead. The summary names what ran: the
  verdict table (one row per criterion, with its verdict and a cell per
  environment), the commit, the environment, the browser, the first line
  of a failed step's error (secrets already redacted), and the command
  that reruns it (see "Records" in [docs/spec.md](spec.md#records)).
  The `pull-requests: write` permission is the cost: the job that runs the
  suite can then write to the pull request. A pull request from a fork gets
  a read-only token, so the step fails there; a team that takes fork pull
  requests moves it to a separate job.
- **The run directory as a build artifact.** Everything one `nuka run`
  measured is in one directory, `.nukadoko/runs/<run_id>/`: `run.json`,
  `summary.md`, and each step record with its traces, screenshots, and
  `http.jsonl` (see "The state directory" in [docs/spec.md](spec.md)).
  The paths inside `run.json` are relative to that directory, so a
  downloaded copy reads the same as the one on the runner. One more step
  in the `run` job uploads it:

  ```yaml
  - name: Upload the run directory
    if: always()
    uses: actions/upload-artifact@cf430e030ddbb5b0abf93d22962f4752f3646cd9 # v7.0.2
    with:
      name: nukadoko-runs
      path: .nukadoko/runs/
      # `.nukadoko` starts with a dot, and upload-artifact skips every
      # file inside such a directory unless this is set.
      include-hidden-files: true
      if-no-files-found: ignore
      retention-days: 14
  ```

  `if: always()` is there for the same reason as in the comment step: a
  red run is the one somebody downloads. On a GitHub-hosted runner the
  directory holds only this job's run; on a persistent runner it holds
  every run retention kept. `nuka do` records sit in `.nukadoko/do/`,
  outside it, since no CI job runs `nuka do`. A trace holds the browser's
  cookies and a screenshot holds what the page showed, so decide who may
  open the artifact before the first upload (see "What this page does not
  claim" below).
- **A script that acts on the run's result.** A step that files an issue
  for each failed scenario, or reruns them, reads `run.json` instead of
  stderr: `nuka run features/ --json > run.json` prints it, and the run
  writes the same file to `.nukadoko/runs/<run_id>/run.json`
  either way. Its `scenarios` entries carry each scenario's status, its
  steps with their line, status, step record, and error, and for a failed
  one the `do` command that reruns it (see "Scenarios (the scripted
  path)" in [docs/spec.md](spec.md)). Its `table` holds each criterion's
  verdict, `held`, `proven`, or `failed`, with the reason ("Verdicts" in
  [docs/spec.md](spec.md#verdicts)).
- **Both sides of a feature switch in one job, not a matrix.** A suite
  that ran the same job once per value of a flag (a `strategy.matrix`
  over `CHECKOUT_V2: ["", "1"]`) declares each value as an environment in
  `nukadoko.program.ts` instead, naming its side in `conditions`
  ("Verdicts" in [docs/spec.md](spec.md#verdicts)). The step stays
  `npx nuka run features/`: a run without `--env` runs each of those
  environments, in one job and one run, and the summary's table shows each
  scenario on both sides. A scenario tagged `@with:checkout_v2` is
  required where the flag is on and a control where it is off, and its row
  is `proven` when its Then breaks there. Two jobs can say that each side
  was green; one run can say that the scenario told them apart. The job
  gates on `nuka run`'s exit code, which a control never turns red. A
  JUnit report built from `nuka report --format messages` leaves the
  controls out and agrees with it; an Allure report shows a control that
  failed as a failed result named `<scenario> (control)`, by design,
  since that failure is the proof.
- **`retention.runs` sized to the runner's own pace.** The default keeps
  the newest 20 runs. A persistent runner that runs every merge and every
  night reaches 20 in days, and `nuka report` and `nuka do --use` read only
  the retained runs, so measure the pace for a week before deciding the
  number.

## What this page does not claim

Neither workflow above has been run inside GitHub Actions itself; nothing
in this repository can execute one. What was verified instead: the YAML
parses as valid YAML, `npm run test:scenarios` was run green and red in a
CLI project with a freshly installed tarball of this package, and every
`npx nuka ...` command in it (including
`nuka run features/`, the directory form used above, not just a single
feature file) was run against a real, freshly `npm install`ed copy of
this package. The
pull request comment step under "What a team adds on top" was not run
either: its `gh pr comment` flags were read from `gh`'s own help, not
exercised against a real pull request.
`npx playwright install --with-deps chromium` was checked with its own
`--dry-run`, not run to completion; `--with-deps` has no effect outside a
Linux runner, which this repository has none of, so the download itself
was not exercised here. The two commit SHAs in the `uses:` lines above
were checked against GitHub's own API, one call each against
`repos/actions/checkout/git/ref/tags/v7.0.1` and the `setup-node`
equivalent, confirming each names the commit its comment claims and
nothing else. The `upload-artifact` SHA under "What a team adds on top"
was checked with `git ls-remote https://github.com/actions/upload-artifact`:
the tag `v7.0.2` names that commit, the newest release tag as of this
writing, and its `action.yml` there declares each input the step uses.
The upload step itself was not run. Read the workflow as a starting shape to adapt, not as a
file this project has watched go green on a real runner.

It also says nothing about where the Allure output goes after the job,
for a project that renders it with `nuka report --format allure` (a run
writes none of its own).
Traces and screenshots are not redacted (see "Environments and
secrets" in [docs/spec.md](spec.md#environments-and-secrets)): the
`http.jsonl` beside them has secrets replaced, but a trace holds the
browser's own state, cookies included, and a screenshot holds whatever the
page showed. A run directory or an `allure-results/` directory uploaded as
an artifact, or a generated report posted to a chat, carries all of that. Keep it inside the
runner, or decide who may open it before the first upload.
