# Reading the verdict table

A run ends in one table, run.json's `table`, and the run summary opens
with it: one row per criterion, one column per world and environment
(`head <environment>`, then the conditions it declares, and under
`--base` also `base <environment>` and `old <environment>`), and one
verdict per row, which the exit code
follows. Under the table, each red row gets one line that says why and
where it stopped. `failed`, `unproven`, and `moved` are red; `held`,
`proven`, and `removed` are green.

## A scenario behind a switch

A passing scenario shows the code does what it says, not that the
scenario would notice if it did not. A feature behind a switch can show
that: give each side of the switch an environment that names its side in
`conditions` (`references/program.md`, "Environments and programs nukadoko does
not start"), and tag the
scenario on its Feature, Rule, Scenario, or Examples line:

- `@with:<condition>`: the condition is on (`true`, or any value).
- `@with:<condition>=<value>`: it has exactly that string. `=true` and
  `=false` are malformed: write `@with:` or `@without:`.
- `@without:<condition>`: it is off (`false`, or not declared).

Its cell is required where the environment meets every tag and a control
elsewhere; an untagged scenario is required everywhere. Each cell in
run.json names the conditions its role came from. nukadoko trusts
`conditions` and does not check them against the program, so derive the
switch from them with `{condition.<name>}` (`references/program.md`).
`nuka run`
without `--env` runs every environment that declares `conditions`, or
the ones the program file's `defaultEnvironments` names. Under `--env`,
a scenario no named environment meets is not run, and the summary counts
it (`<n> criteria not run`). A control never turns the run red. Tag only what the criteria say depends
on the switch, and write the Then so it would fail on the other side: a
When that errors there proves nothing.

When the program writes `flag` lines to `{events}` (`references/program.md`),
run.json's `flags` has one row per flag and side the head steps' lines named:
the side the program got, not the one `conditions` declares. Each row lists
the criteria that evaluated the flag on that side, with the row's `verdict`
and the cells there (with the `gates` the lines named), and `counts` them by
verdict; a criterion seen on the side only in controls counts as `controls`,
because its verdict is about another side. The summary gives each row a line
under "Flags". Read it before a flag is turned on for everyone: `failed` on
the `on` side is a criterion that does not hold with the flag on, and a
control listed only under the side its environment does not declare never ran
the side it was meant to. Join a row with the program's own record of the flag
by `name` and `side`. Two environments whose `conditions` differ in one get
run.json's `paths` too: each criterion's steps compared by what the program
did (`changed`, `open` while a side's lines may still come, `same`), under
"Changed paths". Both are evidence; turning the flag on is the person's call.

## Where no step looked

`lists` in the program file (`references/program.md`, docs/spec.md
"Lists") names the routes and flags the program has, so run.json can
name the places no step reached. With a routes list, `routes` has an
entry per method and route a list or a head step's `request` line
names: `requests` (0 for a route no step requested), `statuses`,
`listed_in` (empty for a route no list names), `handlers`, and the
criteria that sent them. A request is not a check: a Given's counts as a
Then's, so a route with requests may still be one no claim reads. The
summary's "Routes" names the listed routes no step requested, apart from
a PATCH whose handler a PUT reached, and the requests no list names. A
world whose list was not read gives no `routes` and a
`program-list-unread` warning: fix the command before reading a gap.
With a flags list, `flags` has a row for every side it declares, with
no `criteria` for a side no criterion evaluated, and `listed_in`;
`only_side_evaluated: true` (the summary's "only this side was
evaluated") marks a flag whose other sides never ran.
Tell the person which routes no criterion requested; whether one needs a
criterion is theirs to decide.

## Compared with the base

`nuka run --base <the base>` is the run a pull request carries. It
compares each criterion with the base: `unchanged` (a rename, a move, or
a tag such as `@smoke` changes nothing), `changed` (an edit to a step, a
table, a docstring, an Examples row, or a condition tag), `new`, or
`removed`. The summary's first line says what changed, and whether the
mapping did: a step file or helper under the features directory, the
config's fixtures or parameter types, an environment's conditions.

- A `new` or `changed` row also runs in the `base` world, the base's
  code under your criteria and steps. Its Then has to fail there, at one
  line in each of `--proof-runs` runs, for the row to be `proven`. Write
  the Then so it fails without the change: a When that errors there
  proves nothing.
- An `unchanged` row, when the mapping changed, its tags did
  (`retagged`), or its name or file did (`renamed_from`), also runs in the `old` world, your code under the base's feature file, steps, and conditions, and has to
  pass there. A rewritten step that now checks less is what this catches.

## The cells

A cell reads `pass`; `fail@<line>`, a claim broke at that Then line;
`broke@<line>`, it stopped there before a claim was judged; `flaky@<line>`,
its runs disagree; or `·`, it did not run, and its `reason` says why.
Only a claim proves: a failed assertion in a compat or `run` step bound
in Then position is `broke`, so a compat suite's rows are `held` or
`failed`, never `proven`, until their Thens become claim steps. Under
`--base`, a new or changed one is `unproven` for that reason, which its
reason names, unless it is tagged `@held` and passes at the base.
`(control)` marks a control, and `(2 runs)` how often it ran. A control
that failed at a Then line runs again until it has broken the same claim
there `--proof-runs` times (2 by default), each a `proof run <k>/<n>` line on
stderr. Under `--concurrency`, a proof round whose worker could not
finish (its BeforeAll or AfterAll failed) leaves the control `broke` with
the reason and a `proof-run-incomplete` warning: the row reads as one
no control proves (under `--base`, its base cell decides), so correct
the hook. A `broke` cell whose reason says a claim was judged before every
execution event it counts had arrived (`claim-judged-early`) passed or
failed on lines still on their way (the claim's `after_world_stop` in
run.json has the whole count, and its reason names the lines the claim
did not count): the program wrote a line after the step's events read
as whole, so have it write a request's line after the work inside it,
and work that outlives the request as a job (docs/execution-events.md
"Inside first").

## What to do for each verdict

- **`failed`**: a required head cell did not pass. Diagnose it like any
  failure (`references/diagnosing.md`). A row with no required cell is
  `failed` too: no environment of the default selection meets its tags.
  `nuka check` reports that first as `condition-unmet`, and a run under
  `--no-check` as `criterion-without-required-cell`, whose `do:` runs it
  where it is met; add the environment, or correct the tags.
- **`proven`**: it passed where it is required, and a control broke a
  the same claim at one Then line in each of `--proof-runs` runs: the
  scenario tells the behaviour apart. Nothing to do. A control's failure
  has no `do:` and is not a failure to fix.
- **`held`**: it passed where it is required, and nothing showed it would
  notice otherwise. With no control (an untagged scenario, or a run of one
  environment), that is all a run can say. With a control that passed,
  the Then does not check what the switch changes, or the switch does not
  reach what the Then reads: report the row to the person rather than
  calling the criterion covered, and do not rewrite the Then on your own
  to make the control fail. A control that is `broke@<line>` proves
  nothing either: a Given or When failed where the behaviour is absent,
  before any Then was judged. Under `--base`, an `unchanged` row no
  control proves is `held` when the mapping did not change or the old
  world passed it, and a `@held` row when the base passed it.
- **`unproven`** (red): a `new` or `changed` row passed, and nothing
  shows its Then failing without the change: the base passed it, broke
  before a Then, or did not run. When the base already had the
  behaviour (a scenario written for code that works), tag it `@held`
  and ask the person to confirm; otherwise the Then does not see what
  the change did, which is the person's to hear about, not a Then to
  weaken.
- **`moved`** (red): an `unchanged` row passed at head, but not under
  the base's steps, so the approved sentence no longer means what it
  meant. Read the reason: a step that now checks something else is a
  change to report to the person; a reason that says the base's steps
  did not load (a module of the program they import moved) means the
  refactor broke the old steps, and docs/upgrading.md in the package says
  how to land one.
- **`removed`**: the base had the criterion and you dropped it. The
  summary quotes it under "Removed criteria" so the person sees it went.

Each `unproven` and `moved` row is also a `criterion-unproven` or
`criterion-moved` finding with the reason; its `do:` line judges that row
again against the same base, named by its commit hash, so it still
compares with that commit after you commit or the base branch moves. A reason that says `--base` does not support
a shape yet (a symbolic link, a feature file outside the features
directory, a workspace package, a submodule) means that world was not
built: make the `fix:` edit when the finding has one, or run its `do:`
line, which leaves `--base` off, and tell the person the row was not
judged against the base.

## The findings

`nuka check` reads the tags against the environments a run would select
(`nuka check --env` names them as `nuka run --env` does).
`condition-tag-malformed` is a tag that is none of the three forms.
`condition-unknown` names a condition no environment declares: when the
switch was removed, the side whose code stayed decides, so the `@with:`
side keeps the scenario and the tag goes, and the other side means the
scenario goes. `condition-unmet` is a scenario no environment of the
default selection meets; under `--env` it is left out, not reported.
A run that leaves out every scenario it selected runs nothing and fails
with `nothing-selected`: nothing checked is no pass.
`@held` is kept in the row's `conditions`, and only `--base` reads it.
