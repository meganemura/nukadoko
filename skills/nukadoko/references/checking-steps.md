# A Then that claims

## The shape

A Then judges, never in code: its step declares `claims` in place of `run`,
naming the value it reads, how it compares it, and where its expected value
comes from. nukadoko compares, and the step record keeps each claim with both
values and their sources. A typed Then never calls `expect` or `node:assert`.
`defineStep` refuses a claim step that also declares `run`, `returns`,
`mutates`, or `parts`. `nuka check` refuses a Then bound to a step that runs
(`then-without-claims`) and a claim step in a Given or a When
(`claims-outside-then`): a step that reads a value for a later Then is a When.

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

A claim is `{ actual, view?, at?, count?, compare, expected, expected_view? }`.
`nuka scaffold --then --from <step>.<key>` writes this shape when the
line states one value (for a word such as `empty`, the literal of the
chained key's type); `examples/` has a finished Then for a CLI, an API,
and a workflow (`examples/workflow.md` claims a literal and a sentence
value in one step). Write claims as plain data (no getter, Proxy, class
instance, hole, or unknown key) and export what `defineStep` returned: it
validates one frozen copy, and a copy of the step (`{ ...step }`) fails.

## Where the expected value comes from

Pick the source from the sentence; the record names it in `expected_from`.

- **The sentence states it** (a capture, the docstring, or the table):
  `expected: "code"`, recorded as `sentence:code`. The key is required in
  `args`, with no default, and its schema must not rewrite the value
  (`z.coerce`, a transform, a pipe, `trim`, `catch`, a default inside, or a
  refine on an object, an array, or the args object is refused; a schema that
  still changes it leaves the claim `unjudged`). Read it as JSON, lines, or a
  comma list with `expected_view` on a `z.string()` key. With no `observe`, a
  claim reads each value the line states: an unread capture is refused, an
  unread docstring or table `claim-sentence-unread`.
- **An earlier step returned it** ("the item count is unchanged"): `expected:
  { from: "<from key>.<path>" }`, recorded as `from:<step>@<line>.<key>`.
- **The pattern's fixed words state it** ("is refused", "exits 0"):
  `expected: { literal: "refused" }`, or `compare: "is-a", expected: {
  literal: "UUID" }` for "the order id is a UUID". The literal is exactly the
  pattern's own words, `zero` to `twelve` as a number word, `once`, or `twice`
  (any compare), or `0`, `""`, or `[]` for `no`, `none`, `nothing`, or
  `neither` (`0` for `never`, `""` or `[]` for `empty`) with `compare: "equal"`
  only, or `"not-equal"` only right after the fixed word `not`, `neither`, or
  `nor` ("is not empty"). A `neither` that a `nor` follows states nothing. Any
  other literal is refused: `Then the command succeeds` cannot claim `0`.
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
    return { items: await (await request.get("/items")).json() };
  },
  claims: [{ actual: "items", count: true, compare: "equal", expected: { from: "before" } }],
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
returns, never a key the sentence fills (a `from` key hides an `observe` key of
its name, so a step whose claims read no `observe` key is refused); a path
reads own properties only (not `constructor`, not a getter). `view: "text"`
trims the end (a program's last newline), `"lines"` also splits it into lines,
`"json"` parses it, and `"comma-list"` splits it at commas; `at` then takes a
path inside the viewed value, so parsing is data: `{ actual: "stdout", view:
"json", at: "sections.git.0.dirty_count", compare: "equal", expected: "count"
}`. `count: true` then compares the number of items of the array there, with a
number compare only (`at-least` the literal `1` for "at least one row"), and
breaks on a value that is not an array. `{ actual, each: { where?, claims } }`
applies item claims to every item of an array (paths inside are relative to the
item), and breaks when the array, or what `where` selects, is empty. A `where`
claim whose path starts an item claim's, or the reverse, is refused with
`equal`, `has-same-items`, `has-fields`, `lacks-field`, `fits-text`, `is-a`,
`has-item`, `matches`, `contains-text`, `starts-with-text`, or
`ends-with-text`, and breaks the claim where it implies it.

The compares: `equal` (structural), `not-equal`, `contains-text`,
`starts-with-text`, `ends-with-text`, `has-item`, `has-same-items` (in any
order), `has-fields` (the expected fields at any depth, each array whole),
`lacks-field` (no key of the expected name: "has no password field" is
`expected: { literal: "password" }`, and a field set to `null` is a key),
`fits-text` (line by line; a line `...` is any lines, `[..]` any text in its
line), `is-a` (a kind: a JSON type, `integer`, `uuid`, `date`, `timestamp`,
`url`), `matches`, `greater-than`, `at-least`, `less-than`, `at-most`. A JSON
docstring (`expected_view: "json"`) claims a whole response with `equal` (a
field it leaves out breaks it, a `null` one too) or some of its fields with
`has-fields`; output that changes each run takes `fits-text`, never `{ from }`
or `{ observe }`. Two values of different JSON types break the claim (`is-a` and
`lacks-field` aside), and so does an expected value nearly every value holds (a
blank text or field name, a pattern matching `""`, an object with no field, only
`...` and `[..]`). Each side is a plain JSON copy, and `observe` gets a clone of
its inputs; a `Date`, a bigint, `NaN`, an `undefined` item, a `Proxy`, or
nesting past 256 levels leaves the claim `unjudged` (return an ISO string or a
number). Each claim or item the step's deadline cuts off, a running `matches`
included, is `unjudged`, with how many. So is a claim that a key the producer's
`returns` dropped could break. `nuka check` reports a `from` path the producer's
`returns` does not declare (`claim-path-unknown`), a `lacks-field` on a field it
drops (`claim-field-stripped`), a claim whose sides are one place
(`claim-compares-itself`), an `is-a` capture that names no kind
(`claim-kind-unknown`), and a parameter type with a transformer on an expected
key (`claim-expected-transformed`).

## Observe, poll, and a boolean

`observe(fixtures, args)` reads the world when no earlier step returned the
value. It gets every args key but the ones a claim compares with, or the `from`
key of an actual compared with `{ observe }`, and reading one, or calling
`resultOf`, throws: an earlier step's value reaches a claim through `from`
alone. A throw records `unobserved`. Return what you measured, never a verdict:
a text, a number, a list (a claim with `count: true` counts it, so return the
list, not its length). A boolean literal is refused when the actual value comes
from `observe`, since `{ visible: true }` is the judgment made in code. For a
yes or no in the sentence, return the word it uses
(`outcome: "accepted" | "refused"`, `examples/workflow.md`), or the measurement
behind it. Give every `args` and `returns` field of a step you write or rewrite
a `.describe()`, so `nuka describe` connects a criterion's wording to the field
that answers it; a note on a step you are not changing is a report.

`poll: { timeout_ms }` runs `observe` again every 100 ms until every claim
holds on two readings in a row, then judges the last reading once (a poll
longer than the step's deadline stops 100 ms before it). `readings` keep
what each reading read (past 40, the first, the last, and the change
points). A claim step whose `observe` reaches `page`, `context`, or
`pageAs` states `poll`, as `{ timeout_ms }` or `false` (`claim-poll-unstated`).

**One step per claim, or the expected value in the line?** Let the sentence a
non-engineer agreed to decide: "the total is {expected:int}" carries its value,
so it is one step; "is in trial" and "is not in trial" are two steps.

## `expect` in a step that runs

A When may still wait with Playwright's `expect` before it acts. A step runs
outside `playwright test`, so measured against Playwright 1.61.1: the locator
and plain-value matchers and `expect.poll` work as in a Playwright test; a
failing `expect.soft` throws at once, since no runner collects it;
`toMatchAriaSnapshot`, `toHaveScreenshot`, and `toMatchSnapshot` throw
`"<name>() must be called during the test"`, because a step has no current test
to key a snapshot file to. In place of a snapshot, a Then observes the one
property the scenario cares about and claims it against the docstring, which
binds to the one required `args` key that no capture or `from` fills (here
`expected`; see "Typed steps" in `docs/spec.md`):

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
