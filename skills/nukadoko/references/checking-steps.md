# A Then that claims

## The shape

A Then judges, and it does not judge in code. Its step declares `claims`
in place of `run`: which value it reads, how it compares that value, and
where the value it compares with comes from. nukadoko compares, and the
step record keeps each claim with both values and where each came from.
A typed Then never calls `expect` or `node:assert`. `defineStep` refuses a
claim step that also declares `run`, `returns`, `mutates`, or `parts`.
`nuka check` refuses a Then bound to a step that runs (`then-without-claims`)
and a claim step in a Given or a When (`claims-outside-then`): a step
that reads a value for a later Then is a When.

```ts
import { defineStep, z } from "nukadoko";
import runTally from "./run-tally.ts";

export default defineStep({
  pattern: "it exits with {code:int}",
  args: z.object({
    code: z.number().describe("The expected exit code"),
    exitCode: runTally.returns.shape.exitCode,
  }),
  from: { exitCode: [runTally, "exitCode"] },
  claims: [{ actual: "exitCode", compare: "equal", expected: "code" }],
});
```

A claim is `{ actual, view?, at?, compare, expected, expected_view? }`.
`nuka scaffold --then --from <step>.<key>` writes this shape when the
line states one value; `examples/` has a finished Then for a CLI, an API,
and a workflow (`examples/workflow.md` claims a literal and a sentence
value in one step). Write claims as plain data (no getter, Proxy, or
class instance) and export what `defineStep` returned: it validates and
freezes one copy, and a copy of the step (`{ ...step }`) fails to import.

## Where the expected value comes from

Pick the source from the sentence; the record names it in `expected_from`.

- **The sentence states it** (a capture, the docstring, or the table):
  `expected: "code"`, the key itself, recorded as `sentence:code`. The key
  has to be required in `args`, with no default, and its schema must not
  rewrite the value (`z.coerce`, a transform, a pipe, `trim`, `catch`,
  a default anywhere inside, or a refine on an object, an array, or the
  args object are refused at import; the run breaks the claim if the
  schema still changed the value). To read the line's text as JSON or as lines,
  add `expected_view: "json"` or `"lines"` on a plain `z.string()` key.
- **An earlier step returned it** ("the item count is unchanged"):
  `expected: { from: "<from key>.<path>" }`, recorded as
  `from:<step>@<line>.<key>`.
- **The pattern's fixed words state it** ("is refused", "exits 0", "holds
  no items"): `expected: { literal: "refused" }`. The literal is exactly
  the pattern's own words, or `0`, `""`, or `[]` for `no`, `none`, or
  `nothing` (`""` or `[]` for `empty`) with `compare: "equal"` only, or
  `"not-equal"` only right after the fixed word `not` ("is not empty").
  Any other literal is refused: `Then the command succeeds` cannot claim `0`.
- **A second reading** ("A is listed before B"): `expected: { observe:
  "<path>" }`, a value `observe` returned beside the actual one.

```ts
import { defineStep, z } from "nukadoko";
import countItems from "./count-items.ts";

export default defineStep({
  pattern: "the item count is unchanged",
  args: z.object({ before: countItems.returns.shape.count }),
  from: { before: [countItems, "count"] },
  async observe({ request }) {
    const res = await request.get("/items");
    return { count: ((await res.json()) as unknown[]).length };
  },
  claims: [{ actual: "count", compare: "equal", expected: { from: "before" } }],
});
```

```ts
import { defineStep, z } from "nukadoko";

export default defineStep({
  pattern: "{first:string} is listed before {second:string}",
  args: z.object({
    first: z.string().describe("The title expected first"),
    second: z.string().describe("The title expected after it"),
  }),
  async observe({ page }, { first, second }) {
    const titles = await page.locator(".result h2").allTextContents();
    // A title that is not there is undefined, and an undefined value breaks the claim.
    const at = (title: string) => (titles.includes(title) ? titles.indexOf(title) : undefined);
    return { firstAt: at(first), secondAt: at(second) };
  },
  poll: { timeout_ms: 5000 },
  claims: [{ actual: "firstAt", compare: "less-than", expected: { observe: "secondAt" } }],
});
```

## The actual value

`actual` is a path whose first segment is a `from` key or a key `observe`
returns, never a key the sentence fills; a path reads own properties
only (not `constructor`, not a getter). `view: "text"` trims the end
(the newline a program prints last), `"lines"` also splits it into
lines, and `"json"` parses it; `at` then takes a path inside the viewed
value, so parsing is data: `{ actual: "stdout", view: "json", at:
"sections.git.0.dirty_count", compare: "equal", expected: "count" }`.
`{ actual, each: { where?, claims } }` applies item claims to every item
of an array (paths inside are relative to the item), and breaks when the
array, or what `where` selects, is empty. A `where` claim that reads
what an item claim reads (`actual` then `at`, any `view`, any compare)
is refused: "every item" would read as "every item that holds".

The compares: `equal` (structural; key order does not count), `not-equal`,
`contains-text`, `has-item`, `matches`, `greater-than`, `at-least`,
`less-than`, `at-most`. Two values of different JSON types break the
claim, and so does an expected text every string holds (blank under
`contains-text`, a pattern that matches `""` under `matches`). Each side
is a plain JSON copy taken where the value comes from (when `observe`
returns, before the args schema runs), and `observe` gets a copy of its
inputs; a `Date`, a bigint, `NaN`, an `undefined` item, a `Proxy`, or
nesting past 256 levels leaves the claim `unjudged` (return an ISO
string or a number). Judging has the step's deadline: each claim or item
not judged by then, a running `matches` pattern included, is
`unjudged`, with how many. `nuka check` reads each `from` path against
the producer's `returns` (`claim-path-unknown`), reports a claim whose
sides are one place (`claim-compares-itself`), and refuses a parameter
type with a transformer on an expected key (`claim-expected-transformed`).

## Observe, poll, and a boolean

`observe(fixtures, args)` reads the world when no earlier step returned
the value. It gets every args key except the ones a claim compares with,
and reading one of those, or calling `resultOf`, throws: an earlier
step's value reaches a claim through `from` alone. An `observe` that
throws records `unobserved`; a claim not judged is `claim_unjudged`.

Return what you measured, never a verdict: a count, a text, a list. A
boolean literal is refused when the actual value comes from `observe`,
since `{ visible: true }` is the judgment made in code. For a yes or no in
the sentence, return the word it uses (`outcome: "accepted" | "refused"`,
`examples/workflow.md`), or the measurement behind it. Give every `args`
and `returns` field a `.describe()`, so `nuka describe` connects a
criterion's wording to the field that answers it.

`poll: { timeout_ms }` runs `observe` again every 100 ms until every claim
holds on two readings in a row, then judges the last reading once. The
step record's `readings` keep what each reading read (past 40 readings,
the first, the last, and the ones where the value changed). A claim
step whose `observe` reaches `page`, `context`, or `pageAs` states `poll`,
as `{ timeout_ms }` or `false` (`claim-poll-unstated`).

## Reading a broken claim

```text
claim broken: "food: 5.5\nrent: 100" (from:run-tally@16.stdout as text) equal "food: 5.5\nrent: 101" (sentence:expected)
```

The actual value and its source, the compare, the expected value and its
source. The step fails with `claim_broken`, and the run summary lists
every claim under "Claims" with its outcome. A broken claim is fixed in
the implementation or by asking the person, never by a weaker compare.

**One step per claim, or the expected value in the line?** Let the
sentence a non-engineer agreed to decide: "the total is {expected:int}"
carries its value, so it is one step; "is in trial" and "is not in
trial" read as two claims, so they are two steps.

## `expect` in a step that runs

A When may still wait with Playwright's `expect` before it acts. A step
runs outside `playwright test`, so measured against Playwright 1.61.1:
`toBeVisible`, `toHaveText`, the other locator and plain-value matchers,
and `expect.poll` work as in a Playwright test; a failing `expect.soft`
throws at once, since no runner collects it; `toMatchAriaSnapshot`,
`toHaveScreenshot`, and `toMatchSnapshot` throw `"<name>() must be called
during the test"`, because a step has no current test to key a snapshot
file to. In place of a snapshot, a Then observes the one property the
scenario cares about and claims it against the docstring:

```ts
import { defineStep, z } from "nukadoko";

export default defineStep({
  pattern: "the results are titled, in this order",
  args: z.object({
    expected: z.string().describe("Expected titles, one per line, in render order"),
  }),
  async observe({ page }) {
    return { titles: await page.locator(".result h2").allTextContents() };
  },
  poll: { timeout_ms: 5000 },
  claims: [{ actual: "titles", compare: "equal", expected: "expected", expected_view: "lines" }],
});
```

The pattern captures nothing, so the docstring binds to `expected`, the
one required `args` key it leaves unfilled (see "Typed steps" in
`docs/spec.md`). A key the step declares `from` for is spoken for the same
way a captured key is.
