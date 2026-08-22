# Exploring before you know what to write

When you do not yet know what the system does, and so cannot say what a
step should demand or return. Everything here runs through `nuka do`,
whose records are working records rather than evidence, which is exactly
what makes them the right place to be wrong in.

## Seeing the raw thing

A step's `returns` is a contract, and a contract is a filter: what it does
not name is not recorded. That is right for a step a scenario relies on,
and wrong for the first look at a system nobody has described yet.

Write one probe step for the looking. Give it no `pattern`, so it can
never become a line in a feature, and a `returns` of `z.unknown()`, so
nothing is filtered out:

```ts
import { defineStep, z } from "nukadoko";

export default defineStep({
  description: "Send one request and return the whole response, for looking at",
  args: z.object({
    path: z.string().describe("Path under baseURL"),
  }),
  returns: z.unknown(),
  mutates: false,
  async run({ request }, args) {
    const res = await request.get(args.path);
    return { status: res.status(), body: await res.json() };
  },
});
```

`nuka do probe --args '{"path":"/accounts/1"}'` then prints the whole
thing, because `do` writes the step record to stdout. One probe lasts a
project; write it once and stop guessing at shapes.

A permissive `returns` is deliberate here and stays confined to the probe.
The moment you know the shape, the step that a scenario will name declares
it properly. A probe that drifts into being relied on is a contract that
stopped saying anything.

Some apps declare their own tools too, through the WebMCP standard
(`navigator.modelContext.registerTool`). `nuka experimental webmcp-tools
<url>` reads whatever a page has already declared and prints it, another
raw thing to look at, this one named by the app rather than probed for. It
stays `experimental`: the standard's own documentation is not settled
about running it from a caller like this one instead of a human driving
the browser by hand. What it reports never becomes step vocabulary, the
same rule an MCP server over stdio follows, so a scenario can never name a
WebMCP tool. A step that does call one imports
`experimental_callWebmcpTool` directly, not through the fixture bag.

## Seeing what happened in between

Once an operation has more than one move, make each move a part and let
the calling step compose them. The calling step's record then carries a
`calls` entry per part, each with the args it was handed and the result it
returned:

```
$ nuka do quote-net --args '{"sku":"S-1"}'
{
  "result": { "net": 1104 },
  "calls": [
    { "step": "fetch-quote", "args": {"sku":"S-1"},
      "result": {"sku":"S-1","gross":1200,"tax":96,"currency":"JPY"} },
    { "step": "net-of-tax", "args": {"gross":1200,"tax":96},
      "result": {"net":1104} }
  ]
}
```

That is where the next move comes from. The composite returned only `net`,
and the record still shows that the quote carried a currency nobody has
used yet. Reading `calls` is how you find the field you did not know to
ask for.

Each part also runs alone (`nuka do fetch-quote --args ...`), so a half
that misbehaves can be worked on without the rest.

## What continues, and what does not

Inside one execution, the parts share everything: one browser, one page,
one request context. A part sees the page where the part before it left
off, which is what makes a browser flow expressible as parts at all.

Across `nuka do` calls, nothing continues by default. Every call builds
its own browser on a fresh page, and `--session` alone carries only login
state. Values still move forward with `--use <step-record-id>`, which
fills the `from` keys of the next step from a record you already have.

So one shape of an exploration is: keep the unit of a single `do` call
small enough to see what you need, and grow it by adding parts rather
than by chaining `do` calls through a browser. The cost of growing a
composite that way is that each `do` runs it from the start, which is
free for reads and fine for anything repeatable.

For work that cannot be repeated, an account that opens once or an
invoice that would be issued twice, running from the start is not an
option, and that is what a live session is for:

```sh
nuka session start alice
nuka do open-cart --session alice
nuka do add-item --session alice --args '{"sku":"S-1"}'
nuka session stop alice
```

`nuka session start` holds one context open in a process, so `--session`
now lands each call on the world the last one left rather than rebuilding
it. Stopping saves that session's login state to the file `--session` has
always used, so a session is a process while it lives and saved state
once it does not.

Two things keep that readable. `nuka do --session` says on stderr which
world it ran in, live or fresh, because a session that timed out or
crashed underneath you is otherwise invisible until afterwards. And the
step record carries `session_execution`, this call's position in that
session, so a step that passed as the thirtieth execution against a world
nobody can rebuild is never mistaken for one that passed on its own.

Say what a live session is before starting one, and how to stop it. It
outlives the command, holding a browser and live credentials until
`nuka session stop` or its idle timeout. One execution runs at a time.

A world many executions deep is not reproducible, by anyone, which is the
reason to harvest what you found and run it again from nothing rather
than trusting the session itself.

A session left running, or left behind after the terminal that started it
is gone, is easy to lose track of. `nuka session list` finds every one
across every environment, live or only saved, each with its own name and
whether it is still alive; `--json` also names which environment each one
belongs to, which the plain listing leaves out. `nuka session clear
[name]` deletes one by name, or, with no name, every session in `--env`'s
environment (`default` when omitted); a live one refuses to clear until
it is stopped first, since clearing only ever touches files, never a
running process.

`nuka clean [--records] [--cache] [--export] [--dry-run]` is the wider
version of the same idea, once you are done exploring rather than mid-way
through it: it removes accumulated step/scenario records, session cache
files, and the Allure/messages export output, all disposable by design
(see "Artifacts" in `docs/spec.md`). No category flag cleans all three;
`--dry-run` prints the same plan the real run would act on without
removing anything. It refuses the whole command, every category, while
any session anywhere is still live, the same rule `session clear` already
applies to one, widened here because a live session's own process is
still writing records and export output, not sitting idle. Stop every
session first (`nuka session stop <name>`), then clean.
`export/allure-history.jsonl` survives regardless: it sits beside
`allure-results/`, not inside it, and is the one export artifact no
re-run can reproduce.

## What a harvested draft names rather than decides

Three of them, each also reported on stderr.

- **A comment where a step has no pattern.** It could not be a line.
  Decide which it was: give that step a `pattern` if the scenario should
  name it, or leave it out if it belongs inside another step as a part.
- **A line that failed when it ran.** The scenario is red until the
  behavior changes. That is the shape a reproduction takes here: red,
  fixed, green, then `nuka accept`, which refuses while it is red.
- **A line that does not read back to the record it came from.** Its
  wording has to be fixed or it will not bind. This happens where a
  pattern carries optional text or alternation, neither of which reverses
  into one answer.

Nothing needs stripping before the file is committed: which records the
draft came from went to stderr, never into it.

## Then fix what you found

Once the path works, `nuka harvest` turns those records into a feature
draft (see "From an exploration to a scenario" in the skill body). The
probe step stays behind: it has no pattern, so it was never going to
appear in a scenario, and nothing you learned through it is lost, because
what you learned is now written into the contracts of the steps that
replaced it.
