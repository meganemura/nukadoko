# Fixtures: shared setup, cleanup, and waiting

When a scenario needs a project resource a step merely borrows (a tenant, a
seeded database row, an uploaded file), don't write its teardown inside the
step: that puts something in the feature file that is not itself an
acceptance condition. Declare it as a fixture instead, under
`nukadoko.config.ts`'s own `fixtures`, using `defineFixtures` (from the
`nukadoko` package).

## Declaring a fixture

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

declare module "nukadoko" {
  interface StepFixtures {
    tenant: Tenant;
  }
}
```

`tsc` needs the `declare module` block: without it, a step that
destructures `tenant` fails with `Property 'tenant' does not exist on type
'FixtureBag'`. `nuka check` does not need it, because it reads fixture
names from the source text. Write the block in `nukadoko.config.ts`, next
to the fixture, with the type the fixture passes to `use()`.

A step reaches it the same way it reaches `page` or `request`, by
destructuring the name: `async ({ tenant }, args) => {...}`. Setup runs the
first time a step names it; teardown runs after that step's scenario
finishes, in reverse build order, whether the scenario passed or failed.
A setup that exceeds its timeout still fails the scenario, and the report
names the fixture and the phase. The fixture keeps running. If it calls
`use()` after that, the call resolves as `"failed"` and the teardown
written after `use()` still runs, on the teardown budget. That late
teardown runs when `use()` is reached. The timed-out setup produced no
instance, so the reverse-order pass has nothing to include for it. A
failure there is written to stderr. The scenario record may already be
sealed, and stderr is the announcement that still reaches the operator.
A teardown that finishes cleanly writes nothing.
Teardown still runs if `nuka run` or `nuka do` is stopped with SIGINT, SIGTERM, or SIGHUP, and under `nuka run --concurrency` too, in every worker, even when the parent itself is killed.
`use()`'s own return value tells the fixture which, so it can decide for
itself whether to keep what it built (for inspection) or tear it down;
`{ scope: "process" }` in a second, options element of the tuple form
builds it once for the whole `nuka run` invocation instead of once per
scenario, for something genuinely shared across scenarios rather than owned
by one (not for something that must happen exactly once in the world
regardless of process count, like seeding a database: `process` is one
address space, not one invocation). A fixture that never calls `use()`
fails its step by name rather than hanging the run. A second `use()` call
throws at that call, which is in teardown, so it is reported as
`fixture-teardown-failed` and leaves the scenario's status as it was; `nuka
check` catches a dependency cycle among fixtures, a `process`-scope
fixture depending on a `scenario`-scope one, and a fixture that destructures
`call` (only a step's `run` can use that) before anything runs.
`nuka check` also reports `fixture-structural-violation` when a config
fixture's own destructuring cannot be read, or names a fixture nukadoko
does not know. The finding names the fixture.

A program under test that listens on a URL starts in a fixture through
`runServer(command, args, { url })`, which `nuka init --server` writes
(`running.md`, "Setting up"); a `request` override that destructures
`server` makes every request step start it.


## Temporary directories

Don't declare a fixture for a temporary directory: `scratch` is a builtin.
`scratch.dir(prefix?)` returns a new empty directory, and
`scratch.copy(source)` returns a new directory holding a copy of `source`
(relative to the project root), so a scenario that writes never touches
the repository's own files. Every directory is removed when the scenario
ends, pass or fail, and the step record lists each path under
`evidence.scratch`. A project that already declares its own `scratch`
fixture keeps it: its fixture and its `StepFixtures` declaration both win
over the builtin, so delete them only when the builtin's shape is enough.
`nuka tend` names such a fixture as `fixture-replaces-builtin`.

## Waiting for an external effect

A step that writes to a system whose effect lands elsewhere asynchronously
isn't finished when the write is accepted, it's finished once that effect
is visible to whatever runs next. Wait for it there, with the `poll`
fixture, `poll(fn, { description, timeout, interval })`; give `description`
a value and the step record's `polls` carries `attempts`, `waited_ms`, and
`outcome` beside it. `timeout` is a budget for that whole call, including
the attempt in flight: the call ends when the budget ends, and a value
that arrives later is not returned. `timeout` and `interval` must be finite
and greater than zero. Anything else is refused before the first attempt.
Omitting either one keeps its default. That is what separates a wait that actually waited
from one that returned on its first attempt: the second means the
condition was never the late one, and something else is, which is a
different problem with a different fix.

Don't put the wait in a later step that merely reads the effect: that
step's wait then only covers scenarios passing through it, so a sibling
scenario reaching the same state another way fails for no reason that looks
like its own. A green run is no proof the wait sits in the right place, the
value may just have been supplied by that later step's own wait. Only a
route skipping that step can show where the wait actually belongs.

What `fn` waits for matters as much as where the wait lives. It can't be
the thing you're about to observe: when that observation's correct answer
is sometimes absence, waiting for it to appear means it can never come back
absent on purpose, because "not there yet" and "not there" look identical
to the wait. Wait instead for whatever tells you the observation is safe to
make at all (a loading flag going false, a count leaving `undefined`), and
only then read the thing you actually care about. And when that read comes
back absent, return proof the read was valid alongside it, not the absence
alone: a bare `false` can't tell whoever reads the step record later
whether the target really isn't there or the page just wasn't ready to
say.

## Reading a required environment variable

Reach for `requireEnv(name)` over reading `env[name]` directly whenever a
step needs a value it cannot run without: `requireEnv` throws the moment
the key is missing or empty, rather than letting an `undefined` fail later
doing something the missing key had nothing to do with. Read `env` itself
only when a step wants several keys at once, or treats absence as a case
to branch on rather than a config mistake worth refusing over. `env` is a
frozen copy of that merged map. Assigning a property throws, so a write in
one step is not there for a later step or a later scenario. A configured
key still reads back as the loaded value.

The two also differ in what a step record shows afterward. Every name
`requireEnv` is called with, found or not, lands on that step's own
`required_env`, in the order it was read; a value taken straight off `env`
leaves no trace there. Neither ever records the value itself, only the
name it was read by: both draw from the project's configured `envFiles`
(the top-level list, then whatever the running environment's own
`envFiles` appends after it), which is exactly where a secret is most
likely to live. Git classifies those files. A tracked env file stays plain
only while its working tree matches HEAD. Uncommitted edits are redacted.
`nuka check` reports what that classification makes risky: a tracked env
file that holds a secret-looking key (`tracked-secret-looking-key`), and a
redacted value too short to redact safely (`secrets-redact-key-too-short`). A path in that list that is not
on disk contributes nothing, and `nuka check` warns (`env-file-missing`,
or `environment-env-file-missing` for one environment's own list). A path
that is present but cannot be read, or a directory at that path, is
refused before the step runs. The refusal names the configured path and
the errno. `requireEnv` runs only after those files have been read, and
its message names the missing key.

Those files are `KEY=VALUE` text. A `#` comment, an optional `export`
prefix, single quotes, double quotes, and backticks are read, including a
value that spans lines. Double quotes expand `\n` and `\r`. The separator
is `=`. `$NAME` is not expanded. The full rules are in docs/spec.md under
"Environments and secrets". A line that is not a blank, a comment,
or a binding is `env-file-skipped-line` from `nuka check`.
