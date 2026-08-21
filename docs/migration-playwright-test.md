# The second door: a Playwright Test suite

For a project with no cucumber-js and no Gherkin yet: an existing suite
written directly against Playwright Test, tests shaped as `test("...",
async ({ page }) => {...})`, with no glue layer and no import to redirect.
[docs/migration.md](migration.md) covers the other door, the one that
starts from cucumber-js; if that is not your suite, start here instead.

Getting nukadoko itself installed and configured is the same regardless of
which door you use, and none of it is cucumber-specific: install the
package, then run `nuka init` from the project root (`nuka init --help`
lists its flags, including `--base-url` and `--features-dir`). It writes
`nukadoko.config.ts`:

```ts
import { defineConfig } from "nukadoko";

export default defineConfig({
  featuresDir: "features",
  baseURL: "http://localhost:...", // wherever the app under test listens
});
```

A Playwright Test suite already has its own `baseURL`, in
`playwright.config.ts`'s `use.baseURL`. That is a separate field, and
nukadoko never reads it, so the same value ends up written into both
files. Nothing here removes that duplication; it is just how the two
configs sit today.

Neither `nuka run` nor `nuka do` reads `playwright.config.ts` at all, so
its `webServer` field never runs, unlike under `playwright test`, which
starts the app under test through that field before a single spec runs. A
step that calls `request` or `page` before the app is listening fails
with `ECONNREFUSED`. Start the app by hand first.

## Share the implementation, not the runner

Nothing about the existing suite has an import to swap, so this door works
a different way: an operation moves out of a spec file into a plain async
function that takes Playwright's own objects and nothing else. The spec
calls it, and a typed step's `run` calls it too. Neither runner ever loads
the other's files.

```
e2e/cart.spec.ts  ──▶  e2e/lib/cart.ts  ◀──  features/steps/add-item.ts
   (Playwright)          (plain functions)          (nukadoko)
```

The arrows point one way on purpose. The Playwright suite never imports
nukadoko, so what it depends on after the move is exactly what it depended
on before: Playwright, and a function in its own repository. This door's
way back is therefore stronger than the compat door's: reversing that one
means switching an import back; reversing this one means deleting the
feature files and the step files, after which the suite is untouched,
because nothing it uses ever knew nukadoko existed.

What makes the sharing work is a shape, not a promise: `page`, `context`,
`request`, and `baseURL` are Playwright's own objects on both sides (see
docs/spec.md "Context API"), so a function written against them is
already callable from both. Nothing is adapted, wrapped, or re-exported.

## What is deliberately not shared

Anything above that line is deliberately not shared. A spec must not call
`step.run(bag, args)` directly. That looks tempting, and it holds only
while the step destructures Playwright-only names: it breaks the moment
the step reaches for `call`, `section`, `resultOf`, or `requireEnv`, which
is to say the moment the step becomes worth having. A fixture map cannot
be shared either, for the typing reason "Fixtures" gives in
docs/spec.md.

## One contract, on both sides

The contract can live in the shared unit rather than above it, and
should. A step's `args` and `returns` are plain zod schemas, so the
function's own file can export them and the step can declare them:

```ts
// e2e/lib/cart.ts
export const openCartReturns = z.object({ id: z.string() });
export async function openCart(request: APIRequestContext) { ... }

// features/steps/open-cart.ts
export default defineStep({
  patterns: ["a cart is opened"],
  description: "Open a new cart",
  args: z.object({}),
  returns: openCartReturns,
  run: ({ request }) => openCart(request),
});
```

One definition, imported by both homes, so the spec and the step cannot
drift into disagreeing about the shape. The shared file still depends on
nothing but Playwright and zod, so the arrow above stays unchanged.

## Naming where a value comes from: `from`

`from` declares where an args key's value comes from when the pattern
did not capture it (docs/spec.md "Chaining steps"): an upstream step, and
which of that step's own `returns` keys to read.

```ts
// e2e/lib/cart.ts (continuing the file above)
export const addItemArgs = z.object({ cartId: z.string(), sku: z.string() });
export const addItemReturns = z.object({ itemId: z.string(), cartId: z.string(), sku: z.string() });
export async function addItem(request: APIRequestContext, cartId: string, sku: string) { ... }

// features/steps/add-item.ts
import openCartStep from "./open-cart.js";

export default defineStep({
  patterns: ["item {sku:string} is added to the cart"],
  description: "Add one item to the cart opened earlier in this scenario",
  args: addItemArgs,
  returns: addItemReturns,
  from: { cartId: [openCartStep, "id"] },
  run: ({ request }, args) => addItem(request, args.cartId, args.sku),
});
```

`from` names the upstream step by importing it, the same way any other
value gets into a module: `openCartStep` above is `open-cart.ts`'s own
default export. `from`'s own value is always `[<step>, "<key>"]`: the
step that produces the value, paired with which of that step's own
`returns` keys to read. A capture still needs a name of its own,
`{sku:string}`, never cucumber's bare `{string}`; `nuka check` refuses
the unnamed form as `unnamed-capture`. `from` is what fills a key no
capture reached.

This is also what `use` needs. `nuka do --use <record-id>` and
`experimental_recordStep`'s own `use` option (below) both fill a step's
`from` keys from an earlier step record's result. A step with no `from`
entry naming the upstream step has nothing for `use` to fill, and is
refused rather than silently ignored.

## Turning a Playwright run into records: `experimental_recordStep`

Sharing the implementation alone does not produce a record. A Playwright
run leaves Playwright's own artifacts and no step record, because a step
record is written by an executor, and that home has none. An existing
suite could share every line of its implementation and still leave
nothing to harvest.

`experimental_recordStep`, exported from `nukadoko` itself, closes that
gap. It is marked experimental by name, on purpose, so nobody reaches it
by accident, and it drops that mark only once it also supports an
injected `page`, not only `request` (today it always refuses a step whose
fixtures reach for a browser resource), and the API shape has run
unchanged against a real Playwright Test suite, not only against
nukadoko's own tests. `rootDir` is the same project root
`nukadoko.config.ts` and `.nukadoko/` live under for `nuka do`/`nuka run`;
inside a Playwright Test spec that is usually `process.cwd()`.

```ts
const opened = await experimental_recordStep(
  openCartStep, {}, { name: "open-cart", rootDir, request },
);
const added = await experimental_recordStep(
  addItemStep, { sku }, { name: "add-item", rootDir, request, use: [opened.stepRecordId] },
);
```

**Pass the record id to the next call, never the value it returned.** A
spec holds the last result in a variable and hands it on, which is the
natural way to write one and records no chain at all, because none
happened. `use` is what says one did, and it means exactly what `nuka do
--use` means. Skip it and the key reads as something the caller supplied,
so the harvested draft carries that run's own id, passes against a server
that still remembers it, and fails against a fresh one. That failure
arrives long after the run that caused it, which is why it is worth
getting right the first time.

The step runs against the spec's own `request`, its schemas are enforced,
and a step record lands where `nuka do`'s records land. So the suite a
team already runs becomes the source of records, and the journeys it
already encodes become drafts through `nuka harvest`: migrating by
running rather than by rewriting.

Three properties keep that from blurring what a record means. The record
says `kind: "external"`, a third answer to how an execution came about
alongside `do` and `run`, so it cannot be read as something a person
typed; `harvest` accepts it and goes on refusing a `run` record, which
already has a feature. The injected request context is wrapped for the
same logging and redaction any other one gets, and it is never disposed,
since closing what another owner opened is a fault that only appears on
the second call. And a step whose fixtures reach for a browser is refused
before any record exists, so this path cannot half-work by quietly
launching one.

What still does not cross is the sign-off. `nuka accept` needs a green
full `nuka run` and its scenario record, and an external record is not
that. This tool's guarantee is about executions it drove itself, and one
it did not drive is one it can only take somebody's word for. So an
external record is a working record in exactly the sense a `do` record
is: the material a scenario gets harvested from, never the evidence.

## Both trees, one repository

Both of nukadoko's own paths open at once, which is the point of entering
here rather than rewriting. `nuka run` fixes a path in a feature file,
and `nuka do` runs any of those steps alone, so the same operations an
existing suite already trusts become the vocabulary an agent explores
with (see docs/spec.md "Single steps" and "Live sessions").

Both trees can sit in one repository, and either arrangement works. Side
by side is the obvious one. The other is worth naming because it is the
smaller ask of a team whose Playwright suite is the asset: put
`featuresDir` inside the directory their specs already live in.

```
e2e/
  cart.spec.ts          <- Playwright finds this
  lib/cart.ts           <- shared, owned by neither runner
  nukadoko/             <- featuresDir
    cart.feature
    steps/add-item.ts   <- Playwright does not find this
```

That holds because each runner only loads what it recognizes. Playwright
collects files matching its own `testMatch`, which a step file named for
the step it defines never does. Discovery imports every
`.ts`/`.mts`/`.js`/`.mjs` under `featuresDir`, which a spec kept outside
it never is. The two rules are about naming and placement, and they do
not collide.

Two ways to get it wrong, both of which are caught rather than silent. A
spec inside `featuresDir` gets imported by discovery, and Playwright's
`test()` refuses to be called outside its own runner, so the file fails
to import: `nuka check` reports it under the same `step-file-import-failed`
code named in docs/migration.md, carrying Playwright's own error message
this time, and `run`/`do` refuse to execute at all,
exactly as they do for any other broken glue. A step file named like a
spec collides differently: a step's name is its file's basename, so
`open-cart.spec.ts` defines a second step called `open-cart.spec`
carrying the same pattern as the first, and `nuka check` reports
`ambiguous-step` naming both. The pattern matching more than one step is
the error, and the fix is the file name.

The shared file belongs outside `featuresDir` in either arrangement.
Discovery would import it harmlessly, since a module defining no step is
simply not vocabulary, but the placement says who owns it, and the
existing suite does.

## The way back

Delete the feature files and the step files, and the Playwright suite is
untouched, the same promise "Share the implementation, not the runner"
states above: nothing it uses ever imported nukadoko.

`experimental_recordStep` is the one exception to notice on the way out.
A spec file that calls it directly has
`import { experimental_recordStep } from "nukadoko"` written into it, so
if you added those calls to turn that suite's own runs into records,
removing them is part of the same reversal: delete the call sites along
with the feature files and the step files, and nothing is left that ever
knew nukadoko existed.
