# Fixtures in TypeScript

When to declare a fixture, and how setup and teardown run, are in
`../fixtures.md`. This page is how `nukadoko.config.ts` declares one.

## A project fixture

`defineFixtures` in the config's `fixtures` declares each one. A fixture
receives the fixtures it names and a `use` function; what follows
`await use(value)` is its teardown. `[fixture, { scope: "process" }]`
keeps one value for the whole run of an environment.

```ts
// conformance/cases/workflow/config.ts
import { defineConfig, defineFixtures } from "nukadoko";
import { createStore, type Store } from "./src/signup.ts";

export default defineConfig({
  fixtures: defineFixtures({
    store: async ({}, use) => { await use(createStore()); },
  }),
});

declare module "nukadoko" {
  interface StepFixtures {
    store: Store;
  }
}
```

`tsc` needs the `declare module` block: without it, a step that
destructures `store` fails with `Property 'store' does not exist on type
'FixtureBag'`. `nuka check` does not need it, because it reads fixture
names from the source text. A step reaches the fixture the same way it
reaches `page`: `async run({ store }, args)`.

## Replacing a built-in

A fixture named like a built-in replaces it for every step, and receives
the built-in under the same name.

```ts
// conformance/cases/page-override/config.ts
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
