# Fixtures: shared setup, cleanup, and waiting

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
```

A step reaches it the same way it reaches `page` or `request`, by
destructuring the name: `async ({ tenant }, args) => {...}`. Setup runs the
first time a step names it; teardown runs after that step's scenario
finishes, in reverse build order, whether the scenario passed or failed.
`use()`'s own return value tells the fixture which, so it can decide for
itself whether to keep what it built (for inspection) or tear it down;
`{ scope: "process" }` in a second, options element of the tuple form
builds it once for the whole `nuka run` invocation instead of once per
scenario, for something genuinely shared across scenarios rather than owned
by one (not for something that must happen exactly once in the world
regardless of process count, like seeding a database: `process` is one
address space, not one invocation). A fixture that forgets to call `use()`,
or calls it twice, fails loudly by name rather than hanging the run; `nuka
check` catches a dependency cycle among fixtures and a `process`-scope
fixture depending on a `scenario`-scope one before anything runs.

An MCP server over stdio is the same pattern: `connectMcpServer`/
`callMcpTool` (`"nukadoko/mcp"`) belong in a fixture. `nuka mcp-tools --
<command> [args...]` reads its tools separately, never as vocabulary.

## Waiting for an external effect

A step that writes to a system whose effect lands elsewhere asynchronously
isn't finished when the write is accepted, it's finished once that effect
is visible to whatever runs next. Wait for it there, with the `poll`
fixture, `poll(fn, { description, timeout, interval })`; give `description`
a value and the step record's `polls` carries `attempts`, `waited_ms`, and
`outcome` beside it. That is what separates a wait that actually waited
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
