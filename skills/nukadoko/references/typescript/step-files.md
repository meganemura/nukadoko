# Step files in TypeScript

The rules every step follows, whatever its engine, are in `../step-files.md`.
This page is how a TypeScript step file writes them. Run every command as
`npx nuka`.

## A step file

One step per file under `featuresDir`, as the file's `default` export:
`defineStep({ ... })`. Discovery reads that export and nothing else, and
the file name is the step's name (`add-todo.ts` is `add-todo`).

```ts
// conformance/cases/todo/steps-ts/add-todo.ts
import { defineStep, z } from "nukadoko";

export default defineStep({
  pattern: "a todo titled {title:string} is added",
  description: "Create a todo via POST /todos and return the created record",
  args: z.object({ title: z.string().describe("The title of the todo to create") }),
  returns: z.object({
    id: z.string().describe("The id the server assigned"),
    title: z.string().describe("The title as the server stored it"),
    done: z.boolean().describe("Whether the todo is done; false for a new one"),
  }),
  mutates: true,
  async run({ request }, args) {
    const res = await request.post("/todos", { data: { title: args.title } });
    return res.json();
  },
});
```

`args` and `returns` are zod objects. `z` comes from nukadoko itself, so
there is nothing to install for it; a schema your project passes in from
its own zod has to be zod 4. `mutates` defaults to true, so a writing step
can leave it out; a step that only reads says `mutates: false`.
`pattern` is one string. `patterns: [...]` answers more than one line, and
a step with neither is reached only by name.

## Loading

Step files end in `.ts`, except in a CommonJS project (no
`"type": "module"` in `package.json`), where they end in `.mts`. Under
`"type": "commonjs"` Node reads a plain `.ts` file as CommonJS, and
nukadoko is ESM-only. `nuka init` already wrote a matching
`nukadoko.config.mts` in that case.

Node runs a step file by erasing its types, so write TypeScript that
erases cleanly. Import another step file by its own name, `.ts` included
(`import openAccount from "./open-account.ts"`), the spelling `nuka
scaffold --from` writes. When `tsconfig.json` sets neither
`rewriteRelativeImportExtensions` nor `allowImportingTsExtensions`,
scaffold writes `./open-account.js` and a `note:` line instead; `nuka`
loads the `.ts` file under that name, so keep it. Import a type with
`import type`: a type imported without it fails with "does not provide an
export named". An `enum`, a `namespace`, or a constructor parameter
property does not load; `nuka check` reports `step-file-import-failed` at
its line. Write an object with `as const` and a field assigned in the
constructor instead.

## The fixtures a step names

`run`'s first argument, and `observe`'s, is an object destructuring
pattern, every time: nukadoko reads which fixtures to build from its
source text without calling `run`. A step needing no fixtures writes
`run({}, args)`, and one needing neither writes `run()`. `run({ sum })`
reads `sum` as a fixture; when `sum` is an args key, `nuka check` says so
and names `run({}, { sum })`. Any other parameter, `_ctx` included, is
refused. A fixture the project declares in `nukadoko.config.ts` also
needs a `StepFixtures` declaration before `tsc` accepts a step that
destructures it (`fixtures.md`). `page`, `context`, and `request` are
Playwright's own objects, so reach for Playwright's documentation for
what to call on them.

## The deadline

A step's `run` has a deadline: `stepTimeout` in `nukadoko.config.ts`,
twenty minutes unless the project sets it. A step that waits longer by
design declares its own `timeout` in milliseconds on `defineStep`. There
is no value meaning "no limit". `nuka steps` and `nuka describe` show a
declared `timeout`. Any other key on `defineStep` (a leftover
`rationale`, a misspelling) does nothing, and `nuka check` warns
`step-option-ignored`.

## Parameter types

`parameterTypes` in `nukadoko.config.ts` takes a
`{ name, regexp, transformer? }` entry per type: a `negation` type
matching an optional `" not"` and turning it into a boolean lets a pattern
write `will{negated:negation} return` straight into a `z.boolean()` args
key. `transformer` only coerces the matched text; it runs with the
scenario's World as `this`, and a Promise it returns is awaited. A schema
that coerces (`z.coerce.number()` for a `{string}`) keeps
`capture-type-mismatch` quiet, because the run accepts that capture. A
record stores a bigint as its decimal string, and `nuka do --args` takes
a `z.bigint()` field the same way (`{"count":"123"}`).

## Several people in one scenario

`await pageAs(name, { javaScriptEnabled: false })` returns Playwright's
`Page` in a browser context of that person's own, so each keeps their own
cookies. Take the name from the feature line, lowercased
(`pageAs(name.toLowerCase())`).
