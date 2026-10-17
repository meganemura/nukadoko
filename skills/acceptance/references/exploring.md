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

## Exploring state that cannot be repeated

For work that cannot be repeated, an account that opens once or an
invoice that would be issued twice, running from the start is not an
option. Explore that in a browser app through the host's Playwright MCP
server instead of `nuka do`: its tools drive one browser that stays open
between calls, so each call lands where the last one left off.

The server is connected when its tools are in your tool list
(`browser_navigate`, `browser_snapshot`, `browser_click`, and the rest,
under the server's name, usually `playwright`). When they are not there,
ask the person to add it; do not add it yourself. In Claude Code the
command, from the `@playwright/mcp` README, is:

```sh
claude mcp add playwright npx @playwright/mcp@latest
```

It takes effect in a new session. To start the browser from a login that
`nuka do --session <name>` already saved, the server's `--isolated
--storage-state=<file>` options load that session's file,
`.nukadoko/cache/sessions/<env>/<name>.json`.

Say before the first call that the browser acts on the real application
with whatever login it holds. A click that submits a form there is the
same as a `mutates: true` step: it needs a go-ahead first.

A world many calls deep is not reproducible, by anyone, and nothing the
MCP server did is a step record. What you found counts once it is a
scenario: write the steps it needs, write the scenario from what you did
("Then fix what you found" below), and run `nuka check` on it, then
`nuka run` from nothing.

## Saved sessions

`nuka session list` finds every saved session across every environment,
each with its own name and whether a `nuka do --session` call still holds
it; `--json` also names which environment each one belongs to, which the
plain listing leaves out. `nuka session clear [name]` deletes one by
name, or, with no name, every session in `--env`'s environment
(`default` when omitted); one a running call still holds refuses to
clear. An `--env` the config does not define is refused when nothing is
left under it, and stderr names it. Files left under an environment
removed from the config are still cleared, and stderr names that
environment.

A step record has a lifetime without anyone cleaning: `nuka run` keeps the
newest `retention.runs` runs (default 20) and a record no run owns, which
is what a `nuka do` record is, for `retention.adHocDays` days (default 7),
both set in `nukadoko.config.ts`. A `--use <id>` whose
record aged out is refused with those numbers in the message, so an id
that resolved last week and does not today is that, not a typo. Chain
within the window, or raise `adHocDays` for a longer exploration.

`nuka clean [--records] [--cache] [--export] [--dry-run]` is the wider
version of the same idea, once you are done exploring rather than mid-way
through it: it removes every step/scenario record, session cache file, and
the Allure/messages export output at once, all disposable by design
(see "Artifacts" in `docs/spec.md`). No category flag cleans all three;
`--dry-run` prints the same plan the real run would act on without
removing anything. It refuses, before removing anything, when `allure.resultsDir` or
`messages.output` resolves to the project root, to a path outside the
project, or to a parent of the state directory. `--dry-run` refuses those
paths too. A results directory inside the project is still removed, unless
that directory is a parent of the state directory.
`export/allure-history.jsonl` survives regardless: it sits beside
`allure-results/`, not inside it, and is the one export artifact no
re-run can reproduce.

## Then fix what you found

Once the path works, write the scenario from the calls you made. You
already know each step, its args, and which result fed the next one,
because you made each call. Write it the way a reader needs it:

- One line per step that is part of the story, in the order they ran,
  worded to match that step's pattern. Leave out every probe: exploring
  means running things that turned out not to matter.
- Pick `Given`, `When`, or `Then` by what that line tells the person
  reading the scenario, not by what the code did.
- Keep a value an earlier step produced off the line. The step's `from`
  supplies it at run time, as `--use` did during the exploration; a
  literal id from one run passes against that server and fails against a
  fresh one.
- Name the `Feature:` and the `Scenario:` for the behavior being claimed.
  Two paths are two scenarios.
- A call that failed because it reproduced a bug becomes a red scenario.
  It goes green when the behavior changes, and the pull request's run
  summary shows it.

Keep record ids out of the file. They point into the state directory,
which is safe to delete, so a committed feature that named them would
point at nothing.

Then run `nuka check` on the file, which is step 3 of the loop in
`SKILL.md`. It reads each line back against the vocabulary before
anything runs, and names a line no step matches, a line two steps match,
and a required key that nothing supplies.

The probe step stays behind: it has no pattern, so it was never going to
appear in a scenario, and nothing you learned through it is lost, because
what you learned is now written into the contracts of the steps that
replaced it.
