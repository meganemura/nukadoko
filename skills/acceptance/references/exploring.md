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
import { z } from "zod";
import { defineStep } from "nukadoko";

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

Across `nuka do` calls, nothing continues except what `--session` carries,
and that is login state alone. Every call gets its own browser, on a fresh
page. Values move forward with `--use <step-record-id>`, which fills the
`from` keys of the next step from a record you already have.

So the shape of an exploration is: make the unit of one `do` call as small
as you can while still being able to see what you need, and grow it by
adding parts rather than by chaining more `do` calls through the browser.

The cost of growing a composite is that each `do` runs it from the start.
That is free for reads and fine for anything you can repeat, and it is the
thing to watch out for where an operation cannot be repeated (an account
that can only be opened once, an invoice that would be issued twice). For
those, keep the composite down to the part you are still working out, and
`--use` the ids you already have for what came before.

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
