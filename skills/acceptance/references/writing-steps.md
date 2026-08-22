# Writing a step

## The shape of a step file

One step per file, as the file's `default` export. Discovery reads that
export and nothing else, and the file name is the step's name: the
`nuka do <name>` you call it by, and the name every finding and step
record uses for it. Feature files and step files both live under the
configured `featuresDir`, `features` unless the project says otherwise,
with feature files ending in `.feature`.

Step files end in `.ts`, except in a CommonJS project (no
`"type": "module"` in `package.json`), where they end in `.mts` instead:
a plain `.ts` file is read as CommonJS there, and nukadoko is ESM-only.
`nuka init` already wrote a matching `nukadoko.config.mts` in that case
(see the SKILL.md this file supports), so the same rule applies to every
step file underneath it.

```ts
// features/steps/set-product-out-of-stock.ts
import { defineStep, z } from "nukadoko";

export default defineStep({
  pattern: "the product {sku:string} is out of stock",
  description: "Set a product's stock to zero",
  args: z.object({ sku: z.string().describe("The product's own SKU") }),
  returns: z.object({
    stock: z.number().describe("The stock left after the write"),
  }),
  // mutates defaults to true, so a writing step can leave it out; a step
  // that only reads has to say mutates: false.
  async run({ request }, args) {
    const res = await request.post(`/products/${args.sku}/stock`, {
      data: { stock: 0 },
    });
    return res.json();
  },
});
```

`z` above comes from nukadoko itself, so there is nothing to install
separately for it. If your own project already uses zod and you want to
pass one of its own schemas into a step, that schema needs to be zod 4.

`pattern` is one string. Use `patterns: [...]` for a step that answers to
more than one line, and omit both for a step only ever reached by name.

`run`'s first argument has to be written as an object destructuring
pattern, every time, because nukadoko reads which fixtures to build from
that pattern's source text without ever calling `run`. A step needing no
fixtures at all writes `run({}, args)`, and one needing neither writes
`run()`. Any other parameter, `_ctx` included, is refused. `page`,
`context` and `request` are Playwright's own objects, so reach for
Playwright's documentation for what to call on them rather than guessing.

## `page.goto` and baseURL

A leading slash in `page.goto("/path")` replaces baseURL's own path, the
standard URL resolution rule, not something nukadoko adds. Measured
against Playwright 1.61.1 with `baseURL:
"https://demo.playwright.dev/todomvc/"`: `goto("/")` lands on
`https://demo.playwright.dev/`, the host's own root, not the app under
`/todomvc/`. `goto("./")` and the absolute `goto("/todomvc/")` both land
on `https://demo.playwright.dev/todomvc/#/` instead. A step whose app
lives under a path writes one of those two forms for its first
navigation, never a bare leading slash.

## Writing a step that checks something

A step fails when its `run` throws and passes when it does not. There is
no assertion API of nukadoko's own and none is re-exported: `expect` comes
from Playwright, imported directly. Most of what `expect` offers works
the same as it would in a Playwright test; a few matchers need something a
step does not have (see "What `expect` needs from the runner" below).

```ts
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

**Assert with `expect` rather than a bare `throw`.** A step that failed
has no `result` at all, only `error`, so its message is the one place the
observed value can still survive. `expect` writes actual and expected into
that message for you; `throw new Error("mismatch")` throws the evidence
away at the exact moment someone needs it.

**Return what you observed, never a verdict.** `{ matches: true }` tells a
later reader nothing they did not already know from the step passing.
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
`docs/spec.md` for how a table or docstring binds to an `args` key).

## Writing the pattern

Every parameter is `{key:type}`, and the key names the `args` field it
fills: `"a customer {email:string} is onboarded"` fills `args.email`. An
unnamed `{string}` is refused outright, so there is no shorter form to
reach for.

`{key:string}` only matches text wrapped in double quotes; an unquoted
value does not match at all, and `nuka check` reports the whole line as
`undefined-step` rather than naming the missing quotes. `"a customer
{email:string} is onboarded"` binds `a customer "ada@example.com" is
onboarded`, quotes included in the line but stripped from the captured
value; `a customer ada@example.com is onboarded` binds nothing. `{word}`
differs on both counts: it matches one unquoted, space-free token with no
quotes needed, and if a value is quoted anyway, the quotes stay part of
the captured text instead of being stripped.

Do not carry a list of type names around. Get one wrong and `nuka check`
prints the parameter types **this** project has registered, custom ones
from `nukadoko.config.ts` included, which is the only list that is true
here rather than true of nukadoko in general.

Add to that list instead of working around it when a pattern keeps
needing the same shape spelled out by hand. `parameterTypes` in
`nukadoko.config.ts` takes a `{ name, regexp, transformer? }` entry per
type: a `negation` type matching an optional `" not"` and turning it into
a `z.boolean()` lets a pattern write `will{negated:negation} return`
straight into an `args` key of that type. `transformer` only coerces the
matched text; the `args` schema is still what actually validates it. The
one thing a project cannot do is redefine a built-in name (`int`,
`string`, and the rest): that would quietly change what every pattern
already using it means.

The pattern and the schema are checked against each other, both ways: a
key the pattern captures that `args` has no field for is an error, and so
is a required `args` field that nothing captures and no `from` fills.
Neither side can drift away from the other quietly, so adding an `args`
field and forgetting the capture costs you one `nuka check`, never a
browser session.

## Running a step alone before it touches a feature

If the step body needs a local variable with the same name as a fixture,
destructure that fixture under an alias (`run({ page: pwPage, section },
args)`) instead of reusing the name: a same-named local shadows the fixture
silently rather than failing loudly.

`do` gives every call its own browser; `run` shares one page across a
scenario's steps, so a step green under `do` can still fail under `run` if
it depends on state an earlier step left (signed in, navigated elsewhere, a
dialog left open). Passing alone under `do` checks that each step works on
its own, not that it works in the scenario's own order; only `run` checks
that. `nuka do --session <name>` narrows the gap only for login state,
carrying storageState across `do` calls, not where execution had got to, so
anything else still needs fixing in the feature: give shared state its own
step, named for what it establishes, and call it once.

A step that declares `from` (see "Chaining a value from an earlier step"
below) still runs alone: pass the key in `--args` like any other, or add
`--use <step-record-id>` to take it from the result of an execution you
already have. The upstream step's name never goes on the command line, the
cited step record already records which step it belongs to. Repeat `--use`
for as many upstreams as the step reads.

## Return more than what a later step cites

Basing `returns` on citation alone drops the values this step's own
correctness depended on but nothing downstream reads (a computed date, a
chosen id, a resolved name), and those are exactly what a step record gets
read for once something has failed. Return them even if the scenario never
reads them back; the alternative is reconstructing what was actually sent
from another system's error message. This is also what a downstream
failure's own step record can show you: a failed step's `used` entries
carry each upstream step's full `result`, so whatever this step declined to
return is exactly what stays missing from that step record too.

## What `rationale` is for

`description` says what the step does, and is what an agent reads to pick
a step out of the vocabulary. `rationale` says why it is built this way
and what was tried and rejected, and is what an agent reads before
deciding it may rewrite the step. Only `nuka describe` shows it, and it
never reaches a step record: it describes the contract, not one
execution.

Write it wherever a rewrite could destroy something a reader cannot see:
a workaround for the system under test, an approach that was tried and
failed, a constraint that lives outside the code. `nuka tend` reports
every typed step without one as a note and prints the ratio it is moving
(`rationale 2/9`), so treat it as coverage to raise over time. It never
fails a run, and a step with genuinely nothing to say is allowed to keep
its note.

## Chaining a value from an earlier step

When a step needs a value an earlier step produced, reach for `from` first:
`from: { key: [otherStep, "resultKey"] }` declares it, and the value is
filled in before the step runs (the argument stays required, and the
scenario reads as what actually chains to what). Only fall back to the
`resultOf` fixture inside `run` for a read `from` cannot express: the value
needs reshaping on the way, which upstream step to read is decided at run
time, or the whole result is wanted rather than one key of it.

A value that can arrive two ways (created in one scenario, imported in
another) lists both, and the consuming step stays one step: `from: { key:
[[stepA, "id"], [stepB, "projectId"]] }`. There is no priority between them
and no rule to memorize: exactly one of the listed producers has to be
bound earlier in that scenario, so a scenario containing both is an error
rather than a coin flip. If a scenario genuinely exercises both producers,
they are not alternatives at all: give each its own args key and let the
step read both.

Declaring `from` is not just documentation: `nuka check` reads it and
verifies the producing step actually appears earlier in the same scenario,
before anything runs. Run `nuka check <feature>` before the first `nuka
run` so a broken binding order is caught without spending a browser session
on it.

## Helper, part, or step?

Because a chained value can only come from a step, `from` pushes an
operation toward "one step, one responsibility," and that can leave a
scenario with a line that exists only to move a value from one step to the
next, never to record anything the feature's reader cares about (say, "And
the project's billing page is fetched"). A feature file is written for
someone who is not necessarily an engineer; a line like that is a cost to
that reader, not information.

Ask two questions, in order. Does the operation mean something to the
person reading the scenario, not to the code moving data between steps?

- Yes: make it a step. The acceptance record gains a step record for it.
- No: ask the second question.

After a failure, what should be knowable about it?

- Its inputs and its result, under a contract worth stating: make it a
  **part**. Define it with `defineStep` and no `pattern`, list it in the
  calling step's `parts`, and run it with `await call(thePart, {...})`.
  Its args and its result are validated exactly as a step's are, and the
  call is recorded under `calls` on the calling step's own step record.
- Nothing a schema would help with: write an ordinary function under
  `features/steps/lib/` and call it directly. What is given up is that
  helper's own entry in the record; the HTTP it performs is still counted
  in the calling step's `observed`, and the `section` fixture can still
  mark how far execution got while running it. A function that formats a
  payload or picks a fixture file belongs here. Making it a part would
  buy a schema to maintain and nothing else.

A part is a step, not a new kind of thing. That is what makes the split
below cost the feature file nothing.

## Splitting a step a second scenario needs half of

The original step keeps its pattern, its `args`, and its `returns`. Only
its body moves.

1. Move each half into its own file under `features/steps/`, defined with
   `defineStep`, with no `pattern`. Give each one the `args` and `returns`
   it actually demands, not the ones its current caller happens to have.
2. List them in the original step's `parts`, and replace the moved code
   with `await call(thatPart, {...})`.
3. Run `nuka check`. A part the caller did not list is refused at the
   call, and a step declaring `mutates: false` while listing a part that
   declares `mutates: true` is an error: the composite's own flag has to
   account for what it may call.
4. Run the original scenario. Its feature file did not change, so a
   sign-off over it still describes what is on disk.

`parts` takes the imported step objects themselves, never their names,
the same way `from` names its producer:

```ts
import openAccount from "./open-account.js";
import sendWelcomeMail from "./send-welcome-mail.js";

export default defineStep({
  // pattern, description, args and returns are exactly what they were
  pattern: "a customer {email:string} is onboarded on the {plan:string} plan",
  args: z.object({ email: z.string(), plan: z.string() }),
  returns: z.object({ accountId: z.string(), mailId: z.string() }),
  parts: [openAccount, sendWelcomeMail],
  async run({ call }, args) {
    const { accountId } = await call(openAccount, {
      email: args.email,
      plan: args.plan,
    });
    const { mailId } = await call(sendWelcomeMail, { email: args.email });
    return { accountId, mailId };
  },
});
```

Get each part right on its own before wiring the composite back together.
A part with no `pattern` is still vocabulary, so it runs alone like any
other step: `nuka do open-account --args '{"email":"ada@example.com",
"plan":"team"}'`.

When the second scenario wants to name one half as a line of its own,
give that part a `pattern`. It stays callable from the composite at the
same time, so both granularities exist at once and neither scenario is
rewritten for the other.

Fixtures follow the parts: a composite whose part destructures `page` gets
a browser even though the composite itself never names `page`. That is why
`parts` is declared rather than read out of the body, and why a `call` to
a step the caller did not list is refused instead of run.

A read-only environment refuses a `mutates: true` part before it runs,
whatever the composite declared about itself. Splitting a step never moves
a mutation out of that policy's reach.

Everything measured stays on the calling step. `observed`, `sections`,
`used`, `required_env`, the evidence directory, and the trace are the
composite's, and they count the parts' work inside their totals. A part
shares its caller's `ctx`. `from` is never consulted for a call: the
caller passes every key itself.

## Generalizing a step that is too concrete

A step can sit at the right granularity for its scenario and still
hardcode a value the next scenario needs to vary. Add the `args` key,
describe it, and capture it in the pattern. `nuka check` refuses the
mismatch either way round, a required key nothing fills or a capture no
args key accepts, so the refactor is judged before anything runs.

This refactor does change the sentence in the feature file, which the
split above does not. Treat it as needing the same agreement that sentence
had in the first place, and expect `nuka tend` to report a sign-off over
that feature as no longer describing what is on disk. Prefer it anyway
when the hardcoded value is one the feature's reader should have been able
to see. Reach for the split instead when what varies is not a value, but
which half of the step the next scenario wants.

Nothing upstream ever runs on nukadoko's own initiative. If a step's `from`
key names a producer that never appears in the scenario, that is a `nuka
check` / `nuka run` error to fix in the feature file, never something
nukadoko inserts quietly to make the run succeed. A feature that doesn't
name everything that ran stops being the record this whole loop exists to
leave.
