# The TypeScript engine

How a step, a fixture, and a config are written for the npm package.
What a feature file, a claim, a run, and a record mean is the same in both
engines, and [the spec](../spec.md) says it once. The
[Ruby engine's page](../ruby/reference.md) has the same headings in the
same order, so the two can be read side by side.

## Install and command

Node 22.18 or later on the 22 line, or 23.6 or later: the releases that
run a `.ts` file without a flag. nukadoko is a devDependency, and the
project runs it with `npx nuka`:

```sh
npm install -D nukadoko
npx nuka init
```

`init` also adds a `test:scenarios` script to `package.json` (the one
command a person or CI runs), and the steps and the config to the
`include` of `tsconfig.json`, with the compiler option that lets `tsc`
accept an import that names a `.ts` file. The CommonJS case and the
`--allure` flag are in [Setup details](../guide.md#setup-details).

Playwright is an optional peer dependency, needed only by a step that
uses `page` or `request`:

```sh
npm install -D -E playwright@1.63.0
npx playwright install chromium
```

## Configuration

`nuka init` writes `nukadoko.config.ts`. Its default export is
`defineConfig({ ... })`, which checks the options and gives them types.
Each option is described with what it sets: `program` and `fixtures`
below, and `featuresDir` and `parameterTypes` under "Typed steps" in
[the spec](../spec.md#typed-steps).

## Defining a step

One step per file under `features/steps/`, named in kebab-case; the file
name is the step name. The default export is `defineStep({ ... })`:

```ts
import { defineStep, z } from "nukadoko";
import assert from "node:assert/strict";

export default defineStep({
  description: "Create an item through the API so a later step can read it",
  pattern: "an item named {name:string} exists",
  args: z.object({ name: z.string().describe("The item's name") }),
  returns: z.object({
    id: z.number().describe("The id the API assigned"),
    body: z.object({ id: z.number(), name: z.string() }).describe("The item as the API answered it"),
  }),
  async run({ baseURL }, { name }) {
    const res = await fetch(`${baseURL}/items`, { method: "POST", body: JSON.stringify({ name }) });
    assert.equal(res.status, 201, `creating "${name}": status`);
    const item = (await res.json()) as { id: number; name: string };
    return { id: item.id, body: item };
  },
});
```

`mutates: false` declares a step that changes nothing. A step file
imports another by its own file name, `.ts` included. Node strips the
types, so an `enum`, a `namespace`, and a constructor parameter property
do not load ("Typed steps" in [the spec](../spec.md#typed-steps)).

A step that `nuka scaffold --command` writes runs the entry point with
`node` itself. In a project whose `.ts` files import each other with `.js`
specifiers, the entry point is the built program (for example `--command
dist/cli.js`), and `"pretest:scenarios": "npm run build"` keeps a fresh
checkout green; the scaffold refuses a `.ts` entry point that imports a
`.js` file which is absent while its `.ts` sibling is present.

## Fields and schemas

`args` and `returns` are zod objects. `z` is re-exported from `nukadoko`,
so the project needs no zod of its own. `nuka describe` publishes each
schema as JSON Schema, through `z.toJSONSchema`.

## Captures, tables, and doc strings

Each `{key:type}` in the pattern fills the args key `key`. A data table
reaches its key as `string[][]`, and a doc string as a `string`:

```ts
args: z.object({
  todos: z
    .array(z.array(z.string()))
    .describe("The data table's rows, one todo per row, the title in the first cell"),
}),
```

## Claims

A Then step declares `claims` and an `observe` that reads the world, in
place of `run`. nukadoko judges each claim ("Claims" in
[the spec](../spec.md#claims)).

## Chaining (`from`)

`from: { id: [startJob, "id"] }` fills `id` with what the step `startJob`
returned earlier in the scenario. The step is imported, so a rename is a
type error. `startJob.returns.shape.id` reuses the producer's schema for
the key.

## Parts

`parts: [createTodo, completeById]` lists the steps `run` may call, and
`await call(createTodo, { title })` runs one with its args and returns
checked ("Parts" in [the spec](../spec.md#parts)):

```ts
parts: [createTodo, completeById],
async run({ call }, args) {
  const created = await call(createTodo, { title: args.title });
  const completed = await call(completeById, { id: created.id });
  return { id: completed.id, done: completed.done };
},
```

## Fixtures

`defineFixtures` in the config adds a project fixture. The fixture
receives the fixtures it names and a `use` function; what follows
`await use(value)` is its teardown. A fixture named like a builtin
replaces it for every step:

```ts
import { defineConfig, defineFixtures } from "nukadoko";

export default defineConfig({
  fixtures: defineFixtures({
    page: async ({ page }, use) => {
      await page.addInitScript(() => {
        (window as unknown as { wrapped: string }).wrapped = "by the project";
      });
      await use(page);
    },
  }),
});
```

## Context

The first argument of `run` and `observe` is destructured, and the names
it takes are the fixtures the step needs: `page`, `context`, `pageAs`,
`request`, `env`, `requireEnv`, `baseURL`, `scratch`, `section`, `poll`,
`evidence`, `resultOf`, and `call`. `nuka check` reads the pattern without
calling the body ("Context API" in [the spec](../spec.md#context-api)).
`scratch.dir()` returns a fresh directory, removed when the scenario ends.

## Polling and waiting

`poll: { timeout_ms: 3000, settled: [...] }` on a Then step reads
`observe` again until every claim holds on two readings in a row, or the
time runs out.

## Program

The program under test is `program` in the config, a function that
returns how the program starts:

```ts
export default defineConfig({
  program: () => ({ serve: { command: "node src/server.ts", ready: "/items" }, env: { PORT: "{port}" } }),
});
```

Its fields are under "Program" in [the spec](../spec.md#program).

## Types and tooling

`tsc` checks the config and the steps. `nuka init` adds
`rewriteRelativeImportExtensions` to `tsconfig.json` when it names neither
that option nor `allowImportingTsExtensions`, so the `.ts` import names
pass. `"erasableSyntaxOnly": true` makes `tsc` refuse what Node cannot
strip.

## Not in this engine

`nuka sig` writes RBS for Steep and exists only in the Ruby engine.
