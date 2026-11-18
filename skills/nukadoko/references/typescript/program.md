# The program in TypeScript

What the program is, how a world starts it, and every field are in
`../program.md`. This page is how `nukadoko.config.ts` writes it.

## The program

`program` is a function that returns how the program starts. A command
is an argv array, or a string split on whitespace.

```ts
import { defineConfig } from "nukadoko";

export default defineConfig({
  program: () => ({
    build: ["npm run build"],              // once per run, in the tree's root
    prepare: ["node dist/migrate.js"],     // once per world, with env below
    serve: { command: "node dist/server.js", ready: "/health" },
    env: { PORT: "{port}", DATABASE_PATH: "{dir}/app.sqlite3" },
  }),
});
```

## Environments

An entry of `environments` overrides any field of the program, and
`env` merges by key:

```ts
env: { CHECKOUT_V2: "{condition.checkout_v2}" },
environments: {
  "checkout-v1": { conditions: { checkout_v2: false } },
  "checkout-v2": { conditions: { checkout_v2: true } },
},
```
