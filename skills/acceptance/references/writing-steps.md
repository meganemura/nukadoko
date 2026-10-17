# Writing a step

## Reading the vocabulary

`nuka steps --json` lists the whole vocabulary; `nuka describe <step>`
gives one step's full contract. Read the JSON itself for the field
shapes rather than a description of them here, since a shape written
down twice is the one that goes stale. Both name any step file that
failed to import beside everything else they could still read, so a
broken file elsewhere never hides the rest of the vocabulary; `nuka check`
is where to fix the import itself. When a step's args or returns schema
cannot be represented as JSON Schema, `nuka describe` still prints that
step's contract, names the step on the failure, and exits 1. `nuka run`,
`nuka do`, and `nuka harvest` refuse the whole call instead, and that
refusal names the file.

Two fields carry less than they look like they do. A `needs` of `null`
means this tool could not read that step's `run()`, so its fixture
contract is unknown, not empty. A `needs_inferred` list is a lexical
guess at the same question: a starting inventory, never a finished one,
and never grounds for concluding a step needs no browser.

Prefer what already exists. If an acceptance condition can be expressed
with an existing step, use it; do not scaffold a new one just because a
criterion's wording doesn't match a pattern verbatim.

## When the vocabulary has no step for it

Read the `undefined-step` message first. When it ends with `patterned
steps no scanned feature line binds:`, a step that already exists lost
its line, usually through a renamed sentence or a renamed pattern. Fix
the line or the pattern instead of scaffolding a second step.

1. `nuka scaffold <name> --pattern "<feature line>"`, kebab-case, one
   file per step. Each `{key:type}` capture becomes an args field, so the
   file passes `nuka check` against that line before `run` is written. A
   type the project does not register is refused with the registered
   names listed: a number is `{key:int}` or `{key:float}`, not
   `{key:number}`.
   Add `--then` for a step a Then line binds: it writes `mutates: false`
   and no `returns`. Add `--from <step>.<key>` for each value the step
   reads from an earlier step's result: it writes the import, the args
   field, and the `from` entry ("Chaining a value from an earlier step").
   Add `--command <entry point>` for a When step that runs a program
   (`--command src/cli.ts`, relative to the directory `nuka` runs in, and
   refused unless a file is there): it
   writes `const cli = resolve("<entry point>")`, the `runCommand` call in
   `scratch.dir()`, and `returns` of `exitCode`, `stdout`, and `stderr`, so
   a Then step can be scaffolded `--from` it at once. The step runs the
   entry point with `node` itself, so when the project's `.ts` files import
   each other as `./x.js`, name the built program (`dist/cli.js`, with
   `"pretest:scenarios": "npm run build"`); scaffold refuses a `.ts` entry
   point whose `./x.js` import is absent beside an `x.ts`. Without a value the
   `cli` line holds a TODO, and the step throws `fill in the entry point:
   <file>:<line>` until it is filled in. Add `--description "<text>"` for
   what the step does; without it the description is `TODO: describe
   <name>`, which `nuka tend` reports as `step-description-todo`. Leave
   `--pattern` out for a step reached by name only.
2. Implement it. The shape of that file is the next section.
3. `nuka do <step> --args '<json>'`, exercise it alone, check the step
   record, before it ever touches a feature. Fix and re-run until it does
   what it's supposed to; only move on to the feature-level `nuka run` once
   every new step in the scenario has passed this way on its own. A mid-flow
   step needs `nuka session start` instead (`references/exploring.md`).

`mutates` defaults to `true`, a new step is assumed to change state unless
it says `mutates: false`, and `nuka describe <step>` tells you which before
you ever run it, so there's no need to guess. Before the *first* run of a
step whose contract says `mutates: true`, tell the user what it's about to
change and get their go-ahead, once per step, not on every retry while
fixing it, or trial-and-error stops being possible. Steps with `mutates:
false` are observation only (the Then side); they don't need this.

With nobody to ask mid-task, because the caller handed the task over
rather than sitting in the conversation, the go-ahead has to exist before
the work starts. Either the instruction already covered these steps, and
your report says which, or it did not, and you list what you intend to
run and what each changes before starting. Running one and mentioning it
afterwards, because asking was inconvenient, is the one wrong answer.

If the same step still fails after three fix-and-retry cycles, stop and
report where it stands instead of guessing further. A prompt asking for a
different amount of patience ("try up to 10 times") overrides this
default; it is not a config setting. The same budget covers `nuka do
--use` while diagnosing a failed run (`references/diagnosing.md`).

## The shape of a step file

One step per file, as the file's `default` export. Discovery reads that
export and nothing else, and the file name is the step's name: the
`nuka do <name>` you call it by, and the name every finding and step
record uses for it. Feature files and step files both live under the
configured `featuresDir`, `features` unless the project says otherwise,
with feature files ending in `.feature`. A file a scenario runs as a process (a fake server, a fixture script) belongs outside `featuresDir`: discovery imports every module under it on every `nuka check`, top-level code included.

Step files end in `.ts`, except in a CommonJS project (no
`"type": "module"` in `package.json`), where they end in `.mts` instead:
a plain `.ts` file is read as CommonJS there, and nukadoko is ESM-only.
`nuka init` already wrote a matching `nukadoko.config.mts` in that case
(see the SKILL.md this file supports), so the same rule applies to every
step file underneath it.

Node runs a step file by erasing its types, so write TypeScript that
erases cleanly. Import another step file by its own name, `.ts` included
(`import openAccount from "./open-account.ts"`), the spelling `nuka
scaffold --from` writes. Import a type with `import type`: a type imported
without it stays an import and fails with "does not provide an export
named". An `enum`, a `namespace`, or a constructor parameter property does
not load at all; `nuka check` reports `step-file-import-failed` at its
line. Write an object with `as const` and a field assigned in the
constructor instead.

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

`returns` can be left out. It then defaults to an empty object, and `run`
may return nothing. That fits a step with nothing to report beyond passing,
such as a Then step whose observed values arrived as args through `from`.
A step that observed something returns it ("Writing a step that checks
something" below says why).

`run`'s first argument has to be written as an object destructuring
pattern, every time, because nukadoko reads which fixtures to build from
that pattern's source text without ever calling `run`. A step needing no
fixtures at all writes `run({}, args)`, and one needing neither writes
`run()`. A fixture the project declares in `nukadoko.config.ts` also needs
a `StepFixtures` declaration before `tsc` accepts a step that
destructures it ("Declaring a fixture" in `fixtures.md` shows the block). `run({ sum })` reads `sum` as a fixture; when `sum` is an args
key, `nuka check` says so and names `run({}, { sum })`. Any other parameter, `_ctx` included, is refused. `page`,
`context` and `request` are Playwright's own objects, so reach for
Playwright's documentation for what to call on them rather than guessing.
On the compat door those same `page` and `request` names are harness
getters, not bag fields: `defineWorld` refuses them. `nuka check` reports
`step-file-import-failed`, and `nuka run` stops with the same message,
which names the field. Reach them with `await this.openPage()` and
`await this.openRequest()`.

A typed step's `run` has a deadline: `stepTimeout` in `nukadoko.config.ts`,
twenty minutes unless the project sets it. A step that waits longer by
design (an export, a batch job) declares its own `timeout` in milliseconds
on `defineStep`, which overrides `stepTimeout` for that step only. There is
no value meaning "no limit". `nuka steps` and `nuka describe` show a
declared `timeout`; a step that shows none runs under `stepTimeout`.

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
`docs/spec.md` for how a table or docstring binds to an `args` key). A key
the step declares `from` for is spoken for the same way a captured key is,
so a step can read one key from an earlier step and the other from the
docstring on the same line.

## Writing the pattern

Every parameter is `{key:type}`, and the key names the `args` field it
fills: `"a customer {email:string} is onboarded"` fills `args.email`. An
unnamed `{string}` is refused outright, so there is no shorter form to
reach for.

`{key:string}` only matches text wrapped in double quotes; an unquoted
value does not match at all, and `nuka check` reports the whole line as
`undefined-step`. When exactly one pattern fits the line once quoted, the
finding also names the step, the `{...:string}` parameter, and the line
rewritten with quotes. `"a customer {email:string} is onboarded"` binds `a customer "ada@example.com" is
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
matched text. It runs with the scenario's World as `this`, and a Promise
it returns is awaited before the step. The `args` schema is still what
actually validates it. The
one thing a project cannot do is redefine a built-in name (`int`,
`string`, and the rest): that would quietly change what every pattern
already using it means.

The pattern and the schema are checked against each other, both ways: a
key the pattern captures that `args` has no field for is an error, and so
is a required `args` field that nothing captures and no `from` fills.
Neither side can drift away from the other quietly, so adding an `args`
field and forgetting the capture costs you one `nuka check`, never a
browser session.

`capture-type-mismatch` is the type half of that comparison: the JS type
of a built-in capture against the field's primitive type. `{int}`,
`{float}`, `{double}`, `{byte}`, `{short}`, and `{long}` give a number;
`{word}`, `{string}`, the anonymous `{key:}`, and `{bigdecimal}` give a
string; `{biginteger}` gives a bigint. A number capture against a string
or boolean field is the finding, and so is any other pair that differs. A
pipe or transform is read through its input side. A union, `z.any()`, a
preprocess, and a custom parameter type are never reported. It does not fire when the schema coerces the captured value
(`z.coerce.number()` for a `{string}`, `z.coerce.string()` for an
`{int}`), because the run accepts that capture. A field that does not
coerce still is that finding. The one-line description is `nuka check
--codes`.

A record stores a bigint as its decimal string, and `nuka do --args`
takes a `z.bigint()` field the same way (`{"count":"123"}`), not as a JSON
number.

Capturing the same key twice in one pattern is refused too. One args
field holds one value, and keeping the last capture would drop the
earlier one. `nuka check` reports it and `nuka run` refuses the binding
before the step body runs, and both name the key.

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
failed, a constraint that lives outside the code. Leave it out when
there is nothing to say: a placeholder is worse than none. `nuka tend`
prints the ratio (`rationale 2/9`), and `nuka tend --all` names each typed
step without one. It never fails a run.

## Chaining a value from an earlier step

When a step needs a value an earlier step produced, reach for `from` first:
`from: { key: [otherStep, "resultKey"] }` declares it, and the value is
filled in before the step runs (the argument stays required, and the
scenario reads as what actually chains to what). For a new step, `nuka
scaffold <name> --from other-step.resultKey` writes it: the import, the
args field typed by the producer's own schema
(`resultKey: otherStep.returns.shape.resultKey`), and the `from` entry.
It refuses a producer that does not return that key, and names the keys
it does return. Only fall back to the
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

- Yes: make it a step. The run gains a step record for it, and the run
  summary a line.
- No: ask the second question.

After a failure, what should be knowable about it?

- Its inputs and its result, under a contract worth stating: make it a
  **part**. Define it with `defineStep` and no `pattern`, list it in the
  calling step's `parts`, and run it with `await call(thePart, {...})`.
  Destructure `call` in that step's `run`, not in a fixture: `nuka check`
  reports a fixture that names it.
  Its args and its result are validated exactly as a step's are, and the
  call is recorded under `calls` on the calling step's own step record.
- Nothing a schema would help with: write an ordinary function under
  `features/steps/lib/` and call it directly. What is given up is that
  helper's own entry in the record; the HTTP it performs is still counted
  in the calling step's `observed`, and the `section` fixture can still
  mark how far execution got while running it. A function that formats a
  payload or picks a fixture file belongs here. Making it a part would
  buy a schema to maintain and nothing else.
  A helper that runs the CLI under test calls `runCommand` from
  `nukadoko` instead of `spawnSync`: it returns `{ exitCode, signal,
  stdout, stderr }` without throwing on a nonzero exit, and each process
  it starts is listed in the calling step's `observed.processes`, so a
  failure record shows the command, its working directory, and its exit
  code.

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
   reviewer who approved that sentence has nothing new to read.

`parts` takes the imported step objects themselves, never their names,
the same way `from` names its producer:

```ts
import openAccount from "./open-account.ts";
import sendWelcomeMail from "./send-welcome-mail.ts";

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
had in the first place: the changed line shows up in the pull request's
diff, and a person reads it again before approving. Prefer it anyway
when the hardcoded value is one the feature's reader should have been able
to see. Reach for the split instead when what varies is not a value, but
which half of the step the next scenario wants.

Nothing upstream ever runs on nukadoko's own initiative. If a step's `from`
key names a producer that never appears in the scenario, that is a `nuka
check` / `nuka run` error to fix in the feature file, never something
nukadoko inserts quietly to make the run succeed. A feature that doesn't
name everything that ran stops being the record this whole loop exists to
leave.
