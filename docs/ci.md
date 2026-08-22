# Running nukadoko in CI

A recipe, not a requirement: `nuka check` and `nuka run` are ordinary CLI
commands that exit `0` when everything holds and non-zero the moment
something is wrong (see [README.md](../README.md#running-this-in-ci) and
"CLI summary" in [docs/spec.md](spec.md#cli-summary)), so any CI system can
run them. This page fills in what a two-line excerpt cannot: a whole
workflow file, and the four things a project coming from `npx playwright
test` usually has to add by hand that `nuka run` never does on its own.

## A workflow you can copy whole

This is one file, `.github/workflows/nukadoko.yml`. It runs `nuka check` on
every push and pull request (seconds, no browser), `nuka run` after it
passes (the gate that actually executes), and `nuka tend` on a weekly
schedule, since nothing else here reminds anyone to run it.

```yaml
name: nukadoko

on:
  push:
    branches: [main]
  pull_request:
  schedule:
    # Weekly is a starting point, not a rule: pick whatever cadence a
    # human will actually read the output on.
    - cron: "0 6 * * 1"

jobs:
  check:
    if: github.event_name != 'schedule'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      # PR gate: static, seconds, no browser. Put this on every PR; it can
      # fail before anything runs.
      - run: npx nuka check

  run:
    if: github.event_name != 'schedule'
    needs: check
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      # `nuka run` opens a browser; install it here, not on the `check`
      # job above, which never launches one. `chromium` is
      # `browserType`'s own default (docs/spec.md "Sessions, environments,
      # secrets"); add `firefox`/`webkit` too if `browserType` names one
      # of them. `--with-deps` is a Linux-runner requirement: without it,
      # Playwright's own browser binary is present but missing the system
      # libraries it needs to actually launch.
      - run: npx playwright install --with-deps chromium
      # `nuka run` never reads playwright.config.ts, so its own
      # `webServer` field never starts anything (unlike `npx playwright
      # test`, which does): start the app under test by hand, or a step
      # that calls `page`/`request` fails with ECONNREFUSED before it
      # gets anywhere near a real assertion. Replace both the start
      # command and the health check below with this project's own.
      - name: Start the app under test
        run: |
          npm run start &
          for i in $(seq 1 30); do
            curl -sf http://localhost:3000/ && break
            sleep 1
          done
      # Merge/deploy gate: executes, writes step records.
      - run: npx nuka run features/

  tend:
    if: github.event_name == 'schedule'
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      # `nuka tend` reports what is rotting rather than what is broken
      # (docs/spec.md "Tending"); it never gates a PR, which is why it
      # sits on its own schedule rather than beside `check`/`run` above.
      # It exits non-zero only for a sign-off that no longer matches the
      # code it froze; every other finding is a note.
      - run: npx nuka tend
```

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
  webkit each need their own binary too (see "Sessions, environments,
  secrets" in [docs/spec.md](spec.md)); add the ones `browserType` (or a
  test matrix across it) actually needs.
- **The app under test needs starting by hand.** This is the one most
  likely to be missed by someone coming from `playwright test`, whose own
  `webServer` config field starts the app automatically before a single
  spec runs. `nuka run` and `nuka do` read `playwright.config.ts` for
  nothing at all (see
  [docs/migration-playwright-test.md](migration-playwright-test.md)), so
  without an explicit start step, the first step that touches `page` or
  `request` fails with `ECONNREFUSED`, not with anything that names what
  went missing.
- **Something has to remove what accumulates.** `nuka run` writes step
  and scenario records, and both it and `nuka do`/session use can leave
  files under `.nukadoko/cache/`; none of it is deleted automatically (see
  "Artifacts" in [docs/spec.md](spec.md#artifacts)). A GitHub-hosted
  runner is a fresh virtual machine per job, so this never accumulates
  there on its own. A self-hosted or otherwise persistent runner does
  accumulate it, and needs one of two fixes: `rm -rf .nukadoko` at the
  start of the job, or `npx nuka clean` (added for exactly this reason;
  see its own `--help`), which does the same thing more narrowly and
  refuses outright if a live `nuka session` is somehow still running
  against that runner.
- **`nuka tend` needs its own trigger.** Nothing runs it periodically
  unless a workflow says so; the `tend` job above is that trigger, kept
  off the `check`/`run` path on purpose (see "Tending" in
  [docs/spec.md](spec.md#tending)) so a note nobody has to act on today
  never slows down a PR.

## What this page does not claim

The workflow above has not been run inside GitHub Actions itself; nothing
in this repository can execute one. What was verified instead: the YAML
parses as valid YAML, and every `npx nuka ...` command in it (including
`nuka run features/`, the directory form used above, not just a single
feature file) was run against a real, freshly `npm install`ed copy of
this package, including the live-session refusal on `nuka clean` and the
`feature-never-signed` finding disappearing once `nuka accept` runs.
`npx playwright install --with-deps chromium` was checked with its own
`--dry-run`, not run to completion; `--with-deps` has no effect outside a
Linux runner, which this repository has none of, so the download itself
was not exercised here. Read the workflow as a starting shape to adapt,
not as a file this project has watched go green
on a real runner.
