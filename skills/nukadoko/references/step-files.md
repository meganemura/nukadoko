# The step file and its pattern

## The shape of a step file

One step per file, as the file's `default` export. Discovery reads that
export and nothing else, and the file name is the step's name: the
`nuka do <name>` you call it by, and the name every finding and step
record uses for it. Feature files and step files both live under the
configured `featuresDir`, `features` unless the project says otherwise,
with feature files ending in `.feature`. A file a scenario runs as a process (a fake server, a fixture script) belongs outside `featuresDir`: discovery imports every module under it on every `nuka check`, top-level code included.

Step files end in `.ts`, except in a CommonJS project (no
`"type": "module"` in `package.json`), where they end in `.mts` instead.
Under `"type": "commonjs"`, Node reads a plain `.ts` file as CommonJS, and
nukadoko is ESM-only. With no `"type"`, Node loads a `.ts` file only after
it parses it again, with a `MODULE_TYPELESS_PACKAGE_JSON` warning.
`nuka init` already wrote a matching `nukadoko.config.mts` in that case
(`running.md`, "Setting up"), so the same rule applies to every
step file underneath it.

Node runs a step file by erasing its types, so write TypeScript that
erases cleanly. Import another step file by its own name, `.ts` included
(`import openAccount from "./open-account.ts"`), the spelling `nuka
scaffold --from` writes. When `tsconfig.json` sets neither
`rewriteRelativeImportExtensions` nor `allowImportingTsExtensions`, or a
file in its `extends` chain cannot be read, scaffold writes `./open-account.js` and a `note:` line instead; `nuka`
loads the `.ts` file under that name, so keep it. Import a type with `import type`: a type imported
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
may return nothing, which fits a Given that only sets something up. A
Then has no `run` at all: it declares `claims`, and an `observe` when
no earlier step returned the value (`checking-steps.md`). A Given or When
that observes something (a page, a response, a file) returns what it
observed, and declares `returns` for it: without one, a returned key
fails the step as `result_invalid`, naming the key.

`run`'s first argument, and `observe`'s, has to be written as an object destructuring
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
Any other key on `defineStep` (a leftover `rationale`, a misspelling)
does nothing, and `nuka check` warns `step-option-ignored` for it.

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

## Several people in one scenario

When the app tells people apart by a cookie, give each person a browser context of their own:
`await pageAs(name, { javaScriptEnabled: false })` returns Playwright's
`Page` (a `context.newPage()` tab shares cookies). Later calls for a name
return the same page; other options there throw. A name is 1 to 64
lowercase letters, digits, and hyphens, starting with a letter or digit, or it throws:
take it from the feature line, lowercased (`pageAs(name.toLowerCase())`); records tag it with `as`.

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

A pattern is a Cucumber Expression, so three characters are syntax: `/`
separates alternative words, `(` and `)` mark optional text, and `{`
opens a capture. A literal one is escaped with a backslash, `I POST this
body to \/items`, which a JSON string in the step file writes as
`"I POST this body to \\/items"`. Unescaped, `nuka scaffold` refuses the
pattern and `nuka check` reports `pattern-syntax-error`, both naming the
column (`examples/http-api.md`).

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
