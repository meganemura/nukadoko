# A step that checks something

## Writing a step that checks something

A step fails when its `run` throws and passes when it does not. There is
no assertion API of nukadoko's own and none is re-exported. In a project
with no browser (a CLI, an API), `node:assert/strict` is what `nuka
scaffold --then` writes, and it needs nothing installed:
`import("playwright/test")` fails with `ERR_MODULE_NOT_FOUND` where
Playwright is not installed. `examples/cli.md` has a finished Then step of
that kind. Where Playwright is installed, because a step already needs
`page`, `context`, or `request`, `expect` comes from it, imported
directly. Most of what `expect` offers works the same as it would in a
Playwright test; a few matchers need something a step does not have (see
"What `expect` needs from the runner" below).

```ts
// A step that already needs `request`, so Playwright is installed.
import { expect } from "playwright/test";
import { defineStep, z } from "nukadoko";

export default defineStep({
  pattern: "the customer {id:string} is in trial",
  description: "Check that a customer's trial has not ended",
  args: z.object({ id: z.string().describe("Customer id") }),
  returns: z.object({
    trialEndsAt: z
      .string()
      .nullable()
      .describe("The trial end date the service reported"),
  }),
  mutates: false,
  async run({ request }, args) {
    const res = await request.get(`/customers/${args.id}`);
    const customer = await res.json();
    expect(customer.trialEndsAt, "trialEndsAt").not.toBeNull();
    return { trialEndsAt: customer.trialEndsAt };
  },
});
```

Two habits make that record worth reading afterwards, and they cover
opposite outcomes.

**Assert with `expect` or `node:assert/strict` rather than a bare
`throw`.** A step that failed has no `result` at all, only `error`, so its
message is the one place the observed value can still survive. `expect`
writes actual and expected into that message for you, and the scaffolded
`assert.equal(actual, text, ...)` passes a message that starts with both
(`text: expected "Hi, Ada!", got "Hello, Ada!"`), which is the line
`nuka run` prints; `throw new Error("mismatch")` throws the evidence away
at the exact moment someone needs it.

**Return what you observed, never a verdict.** This is for a step that
observes something itself; a Then whose values arrived through `from`
returns nothing, because the producer's step record already holds them.
`{ matches: true }` tells a later reader nothing they did not already
know from the step passing.
`{ trialEndsAt: "2026-09-01" }` tells them what was actually true, which
is what makes a green record worth keeping. Describe those fields: on the
Then side, a field with no `.describe()` breaks the link between an
acceptance criterion's wording and what was actually observed.

The same discipline applies to `args`, not only `returns`: give every
field a `.describe()` so `nuka describe` can connect a criterion's own
wording to the field that answers it, wherever in the step that wording
actually lands.

**One step per claim, or one step with the expected value in the line?**
Let the sentence decide, since the sentence is what a non-engineer agreed
to. "the total is {expected:int}" carries its expected value naturally, so
that is one step. "is in trial" and "is not in trial" read as two
different claims, so they are two steps, and whatever they share goes into
a part they both call.

## What `expect` needs from the runner

A step runs outside `playwright test`, so any matcher that depends on the
runner's own per-test state fails, and the rest do not. What follows was
measured against Playwright 1.61.1, calling `expect` from a plain script
with no runner around it.

The call shape does not tell you which matchers depend on the runner:
`toMatchAriaSnapshot` is called on a locator, `toHaveScreenshot` is called
on `page`, and `toMatchSnapshot` is called on a plain value, the same
three shapes several working matchers also take. What actually
discriminates is whether the matcher reads or writes a snapshot file keyed
to the runner's current test.

Works the same as inside a Playwright test: `toBeVisible`, `toHaveText`,
and the other locator assertions that do not compare against a stored
snapshot; `toBe` and the other plain-value assertions; `expect.poll` (it
keeps polling on its own schedule, not the runner's). `expect.soft` also
asserts correctly, but loses the one thing that makes it "soft": with no
runner to collect into, a failing `expect.soft` throws right away, same as
a plain `expect` would, rather than letting the step continue and
reporting every failure at the end.

Does not work: `toMatchAriaSnapshot`, `toHaveScreenshot`, and
`toMatchSnapshot` each throw `"<name>() must be called during the
test"` the moment they run, because a step has no current test to key a
snapshot file to.

Reach for a different check instead of one of these three. In place of
`toMatchAriaSnapshot`'s comparison of a whole accessibility tree, capture
the one property the scenario actually cares about, ordered rendered
titles, say, and assert it directly against an expected order carried in
a docstring rather than against a serialized snapshot:

```ts
import { expect } from "playwright/test";
import { defineStep, z } from "nukadoko";

export default defineStep({
  pattern: "the results are titled, in this order",
  description: "Check the rendered result titles against an expected order",
  args: z.object({
    expectedTitles: z
      .string()
      .describe("Expected titles, one per line, in render order"),
  }),
  returns: z.object({
    titles: z
      .array(z.string())
      .describe("The titles actually rendered, in order"),
  }),
  mutates: false,
  async run({ page }, args) {
    const titles = await page.locator(".result h2").allTextContents();
    expect(titles.join("\n")).toBe(args.expectedTitles.trim());
    return { titles };
  },
});
```

The pattern captures nothing, so the docstring binds to `expectedTitles`,
the one required `args` key it leaves unfilled (see "Typed steps" in
`docs/spec.md` for how a table or docstring binds to an `args` key). A key
the step declares `from` for is spoken for the same way a captured key is,
so a step can read one key from an earlier step and the other from the
docstring on the same line.
