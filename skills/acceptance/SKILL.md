---
name: acceptance
description: Use when handed a ticket or story's acceptance criteria and asked to turn them into a Gherkin scenario, run it, and leave a sign-off record of that run.
compatibility: Requires the nuka CLI from the nukadoko npm package on PATH; every step below shells out to it (nuka steps, nuka scaffold, nuka do, nuka check, nuka run, nuka accept).
license: MIT
---

# nukadoko acceptance loop

## What this is for

This is acceptance confirmation, not regression testing. A scenario is
written once to prove a ticket's criteria were met, run until green, signed
off, and then left alone — nukadoko never re-runs it, and neither should
you. Hold this distinction before doing anything else below; getting it
wrong throws off every step that follows.

Before writing anything, make sure the acceptance criteria are actually in
hand. If the prompt already states them, or a ticket you've read gives them,
there's nothing to confirm — proceed. If neither is true, ask the user what
this is supposed to do; starting a scenario without knowing what it proves
just produces a scenario that proves the wrong thing.

## The loop

1. Read the vocabulary — `nuka steps --json`, then `nuka describe <step>`
   for the contract of anything that looks relevant.
2. When an operation is missing, `nuka scaffold <name>`, implement it, and
   exercise it alone with `nuka do` until its receipt looks right.
3. Write the feature. A tag and the description under `Feature:` carry the
   ticket id and the criteria in the reviewer's words; the scenarios are
   those criteria translated into the vocabulary.
4. `nuka check <feature>` — undefined steps, pattern/schema mismatches, a
   Then bound to a mutating step, a chained key whose producing step is
   missing, bound too late, or ambiguous between two of them — before
   anything runs.
5. Commit. A run can only be frozen if it happened on a clean tree at the
   commit still checked out, so debugging runs against a dirty tree are
   fine; they simply cannot be accepted.
6. `nuka run <feature>` until green — when it fails, diagnose from the
   failed step's own receipt before repeating the whole run (see "When a
   run fails").
7. `nuka accept <feature>`, then commit the record it wrote.

## Reading the vocabulary

- `nuka steps --json` — every step, typed and compat: name, patterns,
  description, mutates, which fixtures it needs (`needs`, `needs_browser`),
  and where each chained args key comes from. `needs_browser` is how to
  tell, without opening a file, which steps never open a browser at all;
  the chained-args field is how to tell which steps have to run before
  which.
- `nuka describe <step>` — its full contract: args/returns as JSON Schema.
- Prefer what already exists. If an acceptance condition can be expressed
  with an existing step, use it — do not scaffold a new one just because a
  criterion's wording doesn't match a pattern verbatim.

## When an operation is missing

1. `nuka scaffold <name>` — kebab-case, one file per step.
2. Implement it.
3. `nuka do <step> --args '<json>'` — exercise it alone, check the receipt,
   before it ever touches a feature. Fix and re-run until it does what it's
   supposed to; only move on to the feature-level `nuka run` once every new
   step in the scenario has passed this way on its own.

`do` gives every call its own browser; `run` shares one page across a
scenario's steps, so a step green under `do` can still fail under `run` if
it depends on state an earlier step left — signed in, navigated elsewhere,
a dialog left open. The rule above ("passed this way on its own") checks
that each step works alone, not that it works in the scenario's own order;
only `run` checks that. `nuka do --session <name>` narrows the gap only for
login state, carrying storageState across `do` calls — not where execution
had got to — so anything else still needs fixing in the feature: give
shared state its own step, named for what it establishes, and call it once.

A step that declares `from` (see "Chaining a value from an earlier step")
still runs alone: pass the key in `--args` like any other, or add
`--use <receipt-id>` to take it from the result of an execution you already
have. The upstream step's name never goes on the command line — the cited
receipt already records which step it belongs to. Repeat `--use` for as
many upstreams as the step reads.

`mutates` defaults to `true` — a new step is assumed to change state unless
it says `mutates: false`, and `nuka describe <step>` tells you which before
you ever run it, so there's no need to guess. Before the *first* run of a
step whose contract says `mutates: true`, tell the user what it's about to
change and get their go-ahead — once per step, not on every retry while
fixing it, or trial-and-error stops being possible. Steps with `mutates:
false` are observation only (the Then side); they don't need this.

If the same step still fails after three fix-and-retry cycles, stop and
report where it stands instead of continuing to guess. A prompt asking for
a different amount of patience ("try up to 10 times", "don't ask, just keep
going") overrides this default; it isn't something to change in a config
file.

Give every `args` and `returns` field a zod `.describe()`. That's what lets
`nuka describe` connect an acceptance criterion's own wording to a schema
field, so anyone reading the contract later can tell which field answers
which condition. This matters most on the Then side (`mutates: false`): a
step verifying "an error is shown" needs its `returns` field for that
message described, or the link between the criterion and what was actually
observed is lost.

Return more than what a later step cites. Basing `returns` on citation alone
drops the values this step's own correctness depended on but nothing
downstream reads — a computed date, a chosen id, a resolved name — and
those are exactly what a receipt gets read for once something has failed.
Return them even if the scenario never reads them back; the alternative is
reconstructing what was actually sent from another system's error message.
This is also what a downstream failure's own receipt can show you: a
failed step's `used` entries carry each upstream step's full `result` (see
"When a run fails"), so whatever this step declined to return is exactly
what stays missing from that receipt too.

## Chaining a value from an earlier step

When a step needs a value an earlier step produced, reach for `from` first:
`from: { key: [otherStep, "resultKey"] }` declares it, and the value is
filled in before the step runs — the argument stays required, and the
scenario reads as what actually chains to what. Only fall back to the
`resultOf` fixture inside `run` for a read `from` cannot express: the value
needs reshaping on the way, which upstream step to read is decided at run
time, or the whole result is wanted rather than one key of it.

A value that can arrive two ways — created in one scenario, imported in
another — lists both, and the consuming step stays one step:
`from: { key: [[stepA, "id"], [stepB, "projectId"]] }`. There is no
priority between them and no rule to memorize: exactly one of the listed
producers has to be bound earlier in that scenario, so a scenario
containing both is an error rather than a coin flip. If a scenario
genuinely exercises both producers, they are not alternatives at all —
give each its own args key and let the step read both.

Declaring `from` is not just documentation: `nuka check` reads it and
verifies the producing step actually appears earlier in the same scenario,
before anything runs. Once a scenario is written, run `nuka check <feature>`
before the first `nuka run` — see "Before running" — so a broken binding
order is caught without spending a browser session on it.

## Helper or step?

Because a chained value can only come from a step, `from` pushes an
operation toward "one step, one responsibility" — and that can leave a
scenario with a line that exists only to move a value from one step to the
next, never to record anything the feature's reader cares about (say,
`And the project's billing page is fetched`). A feature file is written for
someone who is not necessarily an engineer; a line like that is a cost to
that reader, not information.

Judge each operation on one axis: does it mean something to the person
reading the scenario, not to the code moving data between steps?

- Yes — make it a step. The acceptance record gains a receipt for it.
- No — do not make it a step. Write an ordinary function under
  `features/steps/lib/` and call it from the step that needs the value.
  What is given up is that helper's own receipt; the HTTP it performs is
  still counted in the calling step's `observed`, and the `section` fixture
  can still mark how far execution got while running it.

Nothing upstream ever runs on nukadoko's own initiative. If a step's `from`
key names a producer that never appears in the scenario, that is a
`nuka check` / `nuka run` error to fix in the feature file — never
something nukadoko inserts quietly to make the run succeed. A feature that
doesn't name everything that ran stops being the record this whole loop
exists to leave.

## A resource that needs its own cleanup

When a scenario needs a project resource a step merely borrows, a tenant,
a seeded database row, an uploaded file, don't write its teardown inside
the step: that puts something in the feature file that is not itself an
acceptance condition. Declare it as a fixture instead, under
`nukadoko.config.ts`'s own `fixtures`, using `defineFixtures` (from the
`nukadoko` package) so the fixture's own dependencies stay fully typed:

```ts
export default defineConfig({
  fixtures: {
    tenant: async ({ request }, use) => {
      const t = await createTenant(request);
      await use(t);
      await destroyTenant(request, t);
    },
  },
});
```

A step reaches it the same way it reaches `page` or `request`, by
destructuring the name: `async ({ tenant }, args) => {...}`. Setup runs the
first time a step names it; teardown runs after that step's scenario
finishes, in reverse build order, whether the scenario passed or failed.
`use()`'s own return value tells the fixture which, so it can decide for
itself whether to keep what it built (for inspection) or tear it down;
`{ scope: "process" }` in a second, options element of the tuple form builds
it once for the whole `nuka run` invocation instead of once per scenario,
for something genuinely shared across scenarios rather than owned by one
(not for something that must happen exactly once in the world regardless of
process count, like seeding a database: `process` is one address space, not
one invocation). A fixture that forgets to call `use()`, or calls it twice,
fails loudly by name rather than hanging the run; `nuka check` catches a
dependency cycle among fixtures and a `process`-scope fixture depending on
a `scenario`-scope one before anything runs.

## Waiting for an external effect

A step that writes to a system whose effect lands elsewhere asynchronously
isn't finished when the write is accepted — it's finished once that effect
is visible to whatever runs next. Wait for it there, with the `poll`
fixture, `poll(fn, { description, timeout, interval })`; give `description` a
value and the receipt's `polls` carries `attempts`, `waited_ms`, and
`outcome` beside it. That is what separates a wait that actually waited
from one that returned on its first attempt — the second means the
condition was never the late one, and something else is, which is a
different problem with a different fix.

Don't put the wait in a later step that merely reads the effect: that
step's wait then only covers scenarios passing through it, so a sibling
scenario reaching the same state another way fails for no reason that looks
like its own. A green run is no proof the wait sits in the right place —
the value may just have been supplied by that later step's own wait. Only a
route skipping that step can show where the wait actually belongs.

What `fn` waits for matters as much as where the wait lives. It can't be
the thing you're about to observe: when that observation's correct answer
is sometimes absence, waiting for it to appear means it can never come back
absent on purpose, because "not there yet" and "not there" look identical
to the wait. Wait instead for whatever tells you the observation is safe to
make at all — a loading flag going false, a count leaving `undefined` — and
only then read the thing you actually care about. And when that read comes
back absent, return proof the read was valid alongside it, not the absence
alone: a bare `false` can't tell whoever reads the receipt later whether
the target really isn't there or the page just wasn't ready to say.

## Adding your own evidence

The automatic evidence (screenshot, trace, `http.jsonl`, `page_events`) never
covers something application-specific: an API response body, a DB row, a
generated file's contents. Reach for the `evidence` fixture instead of
`console.log`-ing it away or writing it to disk with no place on the receipt
to point back at:

```ts
async run({ evidence, request }, args) {
  const res = await request.get("/orders");
  await evidence.attach("orders.json", await res.body());
}
```

`evidence.attach(name, body)` writes and lists the attachment on the
receipt's `evidence.attachments` in one call. `evidence.path(name)` only
allocates a path, Playwright's own `outputPath()`, for a step that writes
with its own tool instead of handing `attach` a buffer directly; only a path
a step actually wrote to lands on the receipt, so calling `path()` without
following through leaves nothing behind, on purpose. Calling either twice
with the same `name` keeps both files: it never overwrites the first.

Keep secrets out of whatever you hand `attach`. The receipt's own
`name`/`file` strings are redacted like every other field, but a file's own
contents are not, since redacting arbitrary bytes would corrupt them about
as often as it would protect them.

## Writing the feature

Everything you were able to learn about the ticket goes into the feature
file. nukadoko has no concept of a ticket, so the feature is the only place
that link is recorded — and accepting it (see "Running and accepting")
freezes the whole file into the record, which is what someone reads back
months later.

If you can reach the tracker at all — an MCP server, `gh issue view`, a Jira
CLI, or just the ticket pasted into the prompt — carry across its id, URL,
title, and acceptance criteria in the reviewer's own words, unparaphrased.
How you reached it doesn't matter and isn't worth recording; that the record
can be traced back to what it accepted does.

```gherkin
@PROJ-123
Feature: Sign in with valid credentials

  Ticket: https://example.atlassian.net/browse/PROJ-123
  Title: A user can sign in with a correct email and password

  Acceptance criteria (verbatim from the ticket):
  - Signing in with a correct email and password lands on the dashboard
  - A wrong password shows an error and does not sign the user in

  Scenario: ...
```

The tag carries the id in a form something can grep for; the free text under
`Feature:` carries what a person needs. Follow whatever tag shape the project
already uses (`@PROJ-123`, `@issue-456`) — Gherkin tags cannot contain `#`,
so a bare issue number needs a prefix.

Don't write a field you couldn't fill. An empty `Ticket:` line is worse than
no line at all: it reads as a link that was lost rather than one that was
never available.

Each scenario is that same criteria translated into the vocabulary read in
"Reading the vocabulary" above. Where the translation is a judgment call,
that judgment is what PR review of the feature is for.

## Before running

`nuka check <feature>`. Undefined steps, pattern/schema mismatches, a Then
bound to a mutating step, a step whose `from` key has no producing step
earlier in that scenario or has two of them competing — every static
inconsistency it can catch, catch before anything executes. Those last
ones otherwise cost a whole browser session to discover, since the
scenario looks correct until the consuming step actually runs.

If the feature's directory is in `additionalFeatureDirs` (see "What not to
do"), a bare `nuka check` already covers it, the same as any feature under
`featuresDir`. Otherwise pass the feature path directly: `nuka check
<feature>` checks that one file, since without either the argument or the
config entry the one file you care about is the one that goes unchecked.

## Running and accepting

All of the trial and error above — `nuka do` while building a step, `nuka
run` while getting the feature green — happens against a verification
environment. Never pass a production-pointing name to `--env`. An
environment configured with `policy: "read-only"` is a second backstop, not
a substitute for picking the right one: the engine refuses any mutating step
there outright, regardless of what `--env` was given.

1. Commit. A dirty working tree can never be accepted, so get everything
   the run needs — including any step files from "When an operation is
   missing" above — into a commit first.
2. `nuka run <feature>` — repeat until every scenario is green. When a
   scenario fails, diagnose it before repeating the whole run (see "When a
   run fails") rather than treating a full re-run as the default first
   move. `<feature>:<line>` is fine for narrowing this while iterating,
   but the run this step ends on must cover the whole feature — `accept`
   never treats a partial run as a candidate, however green it was.
3. `nuka accept <feature>` — freezes the newest all-green run of that
   feature as a record beside it, restricted to runs matching the current
   condition: `--env` (resolved the same way `nuka run`'s is; omit for the
   default environment) and whatever `config.browserType` says right now,
   both matched against what each candidate run actually measured, never a
   declaration. A run that never opened a browser is a candidate regardless
   of `browserType` (there is no `--browserType` flag on `accept`, since it
   is fully config-derived). Every record's filename bakes its own
   condition in (environment, then browser or `no-browser`), so accepting
   this feature again later under a different measured condition writes a
   separate record instead of overwriting this one; when two runs differ
   only by environment, `--env` is what picks which one gets frozen.
4. Commit the record `accept` wrote.

## When a run fails

Before repeating `nuka run <feature>`, read the failed step's own receipt.
On a failure, each of that step's `used` entries carries `result`: the
full validated result of the upstream step it read from, sitting right on
the receipt that failed. One receipt is usually enough to see what the
step actually saw and why it didn't hold up — no second receipt.json to
open and cross-reference by hand.

Read it as one timeline rather than a bag of separate fields: `started_at`,
`finished_at`, `sections[].at`, `polls[].at`, `actions[].at`, and
`evidence.screenshots[].at` all share the same clock, so sorting them
together turns the receipt into an ordered account of what happened when.

```sh
jq -r '([{at: .started_at, event: "started"}, {at: .finished_at, event: "finished"}]
  + (.sections // [] | map({at, event: "section:\(.label)"}))
  + (.polls // [] | map({at, event: "poll:\(.description // "poll")"}))
  + (.actions // [] | map({at, event: "action:\(.method) (\(.ms)ms, \(.outcome))"}))
  + (.evidence.screenshots // [] | map({at, event: "screenshot:\(.file)"})))
  | sort_by(.at)[] | "\(.at)  \(.event)"' receipt.json
```

`actions` is every Playwright call this step made through the `page`
fixture, `expect` waits included, each with its own duration and outcome, read
straight off the step's own trace: an `expect` that timed out shows up here
with `outcome: "failed"` and a real `ms`, often enough to explain a failure
without opening the trace viewer at all.

If the step opened a browser (destructured `page`), also check `page_events` on
that receipt: a console error, an uncaught page error, or a failed request
recorded there can explain a failure nothing else on the receipt mentions,
since it comes from the page itself rather than anything the step declared.

If an absence claim turns up on that timeline, check whether its own
moment sits before whatever readiness evidence the step returned alongside
it. Earlier means the read landed before the page was ready to be read,
premature, not a state problem to go chase in the app. Don't trust
`final.png` to show the moment of failure either: it's taken once the step
has already returned or thrown, during teardown, so compare its `at`
against `finished_at` rather than the screenshot's contents alone (a gap of
several seconds between them reads, at a glance, like state that was
flickering, and it has been misdiagnosed as exactly that). Reach for the
trace only when the DOM itself is what's in question: `npx playwright
show-trace <evidence.dir>/trace.zip`. That trace is this one step's own
window now, not the whole scenario's recording, so what it shows is exactly
this failure, nothing earlier in the scenario to scrub past first.

If that receipt only sharpens a hypothesis rather than confirming it, test
the hypothesis with `nuka do <step> --use <upstream-receipt-id>` instead of
re-running the scenario. It executes the one step in question — seconds,
where a full `nuka run` costs minutes — and it still counts toward the
same three-fix-and-retry-cycles rule described above ("If the same step
still fails after three fix-and-retry cycles...").

Re-run the whole feature last, once the step itself passes under `do` —
not as the first thing tried after a failure. Repeating `nuka run` end to
end is the expensive way to learn what a single receipt, or a single `do`
call, would already have told you.

## When accept refuses

`accept` has seven refusal conditions, and it always says which one fired,
in stderr, along with the next command to run. Read that message and act on
it — don't guess, and don't look up the list elsewhere first; stderr is the
source of truth here and anything written in this file would just go stale
next to it. One of the seven, "no run to freeze", now includes a fourth
shape: a green full run of the feature exists, just not under the current
condition. That refusal names the condition it looked for and lists every
condition that does have a run, so the next move is either `nuka run
<feature>` again under the current condition or pointing `accept`'s own
`--env` and/or `browserType` in the config at one of the ones already
listed, never a guess between them.

## Keeping records honest over time

A record freezes the feature source and every receipt from the run it
accepted — but not the contracts behind them. Change a step's `returns`
after accepting, edit the feature, or delete a step it cites, and the
record still sits there claiming a green run it can no longer support.
Nothing about that stops a future run, so `nuka check` never mentions it.

`nuka tend` is what finds it: a frozen result that no longer passes its
step's current schema, a frozen feature source that no longer matches the
file, a cited step gone from the vocabulary. Those exit non-zero, so a
periodic job can act on them.

Run it periodically, not in the loop above — it answers whether the
vocabulary and its records are healthy, not whether this run can proceed.
When it reports a stale record, the fix is to run the feature again and
`nuka accept` it again, or to undo the change that invalidated it. Never
by editing the record.

`nuka tend` also reports a note, `signoff-condition-mismatch`, when a
feature's most recent sign-off recorded a browser the config no longer
declares. This one never exits non-zero: nothing about that sign-off is
wrong yet, and a project accepted under chromium is not required to also
accept under firefox. A record accepted before this note existed reports
nothing here at all; there is no condition on it to compare.

## What not to do

- Don't put an acceptance feature inside the project's regression suite —
  keep it outside `featuresDir`, so it never runs as part of the regular
  suite. Add its directory to `additionalFeatureDirs` in
  `nukadoko.config.ts` so `nuka check` and `nuka tend` still see the steps
  it binds, instead of reporting them unbound — without it ever running
  unattended. If you can't touch the config, pass the feature path to
  `nuka check` instead (see "Before running").
- Don't hand-edit a written record. It exists because it was measured, not
  claimed; editing it by hand turns it back into a claim.
- Don't delete a record and redo it to get a cleaner one. Its git history
  *is* the acceptance history — a second attempt is a new commit, not a
  replacement.
