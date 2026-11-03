# Worlds that differ in what no criterion may depend on

A criterion such as "an order placed late in the UTC day keeps that day"
should hold whatever time zone the server runs in and whatever day the
run happens on. One run shows it in one zone on one day, so a defect of
the zone or the clock is missing from the run and from its summary
(docs/spec.md, "Out of scope"). Declare the worlds that would show it,
and the verdict table turns the defect red.

Four axes, and where each one lives:

- **Order**: `nuka run <feature> --order shuffled`; a red rerun of the
  `do:` line is an order dependence (`references/running.md`).
- **The same world again**: `nuka run <feature>:<line> --repeat <n>`;
  runs that disagree are `flaky@<line>`, which is red.
- **Time zone and clock** (and a random seed): one environment per value,
  below. The program reads each value from its environment variables, so
  nothing new is needed in nukadoko.

## The program file

Each environment declares its zone and its clock as `conditions`, and
`env` hands the same values to the program through `{condition.<name>}`,
so the column heading and the program cannot disagree:

```ts
import { defineProgram } from "nukadoko";

// Two zones by two pinned clocks. A combination left out is not run, and
// nothing reports it, so the cross product is written once, here.
const zones = { utc: "UTC", tokyo: "Asia/Tokyo" };
const clocks = { midmonth: "2026-03-10T12:00:00Z", monthend: "2026-01-31T12:00:00Z" };
const environments = Object.fromEntries(
  Object.entries(zones).flatMap(([zone, tz]) =>
    Object.entries(clocks).map(([clock, now]) => [`${zone}-${clock}`, { conditions: { tz, now } }]),
  ),
);

export default defineProgram({
  serve: { command: "node src/server.ts", ready: "/health" },
  env: { PORT: "{port}", TZ: "{condition.tz}", NOW: "{condition.now}" },
  environments,
});
```

- **Tag no scenario with these conditions.** An untagged scenario is
  required in every environment, which is the claim: it holds in each
  zone. `@with:tz=UTC` would make the Tokyo cell a control, and a control
  never turns the run red.
- **The clock is the program's seam, not nukadoko's.** nukadoko cannot
  move a program's clock. The program reads "now" from one place that
  honours a variable (`NOW` above), or a library does it for it:
  libfaketime under any process, Timecop in Ruby. `TZ` needs no seam:
  Node, Ruby, and the C library read it at start.
- **A condition value holds no whitespace and no `@`**, where a Gherkin
  tag would end. libfaketime's absolute form, `@2026-03-10 23:30:00`,
  cannot be one: use its relative form (`+14h`) or a seam that reads an
  ISO time.
- **The world's `env` reaches the step's process too** (`process.env`
  during the run), and Node switches zones when `process.env.TZ` changes.
  A step that computes its expected date from its own clock or zone moves
  the same way the program does, and hides the defect. Write the input
  time and the expected date as literals in the sentence: `When an order
  is placed at "2026-03-10T23:30:00Z"`, `Then its business day is
  "2026-03-10"`.

## Reading the result

The column headings carry each environment's conditions, so the red
columns line up on `tz` or on `now`. A red row's reason names where it
broke and where it held:

```text
| failed | `features/orders.feature:3` an order placed late in the UTC day keeps that day | pass | pass | fail@5 | fail@5 |
- ...: a claim broke at line 5 in tokyo-midmonth, tokyo-monthend, and passes in utc-midmonth, utc-monthend, where it is required too
```

The reason names no cause: the environments can differ in more than their
conditions. Rerun one world with the finding's `do:` line, which names it
with `--env`.

## Under `--base`

A fix for a zone defect proves itself only in a world that shows the
defect. A new criterion for a business-day fix, run with UTC worlds alone,
was `unproven` (`base utc: pass`); with a Tokyo world beside it, the base
cell there was `fail@13 (2 runs)` and the row was `proven`. Keep these
environments in the run CI posts with `--base`.

## The cost

Every environment is a world: two zones by two clocks runs each scenario
four times, and so does the base world under `--base`. With switch
environments already there (`checkout-v1`, `checkout-v2`), write the
cross product by hand, each entry declaring the switch and the zone; the
switch's tags keep working, since each entry still declares its side.
`defaultEnvironments` keeps a run without `--env` on a few of them; then
say in the pull request which worlds CI runs, since a local green and a
CI red can disagree, and the column headings say which world was which.

## What stays out of reach

Only the values an environment declares are tried. A defect at a moment
no clock pins (a daylight-saving change, a leap day, a year end) or in a
zone none names stays invisible, and a reading of the real clock that
bypasses the program's seam is not pinned at all. Pick the values from where the
criteria say the boundary is.
