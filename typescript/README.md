# nukadoko for TypeScript

[![npm version](https://img.shields.io/npm/v/nukadoko?logo=npm)](https://www.npmjs.com/package/nukadoko)

The TypeScript engine of [nukadoko](https://github.com/meganemura/nukadoko#readme): typed step contracts for Gherkin, written in TypeScript, so a scenario can be told wrong before it runs.
It reads the same feature files as the Ruby engine and must judge them the same way; the cases in [`conformance/`](https://github.com/meganemura/nukadoko/blob/main/conformance/README.md) hold it to that.
What a feature file, a claim, a run, a step record, and a verdict are is the same in both engines, and the [project README](https://github.com/meganemura/nukadoko#readme) and the [documentation site](https://meganemura.github.io/nukadoko/) say it once.
This page is what only the TypeScript engine needs: how to install it, how a step is written, and what its commands add.

## Install

Node 22.18 or later on the 22 line, or 23.6 or later: the releases that run a `.ts` file without a flag.
nukadoko loads the config and the step files with Node's own type stripping, so it installs no TypeScript loader of its own.

```sh
npm install -D nukadoko
```

It installs no browser. Playwright is an optional peer dependency, needed only by a step that uses `page` or `request`:

```sh
npm install -D -E playwright@1.63.0
npx playwright install chromium
```

The peer range is `^1.61.1`, so a project already on a later Playwright 1.x keeps its own version.
Without it, `nuka check` names that step and this install command before anything runs, and every other command works, `tsc` included: the types of `page` and `request` are `any` until Playwright is installed.

`npx nuka init` writes `nukadoko.config.ts`, the empty `features/steps/`, and the `.gitignore` entries for `.nukadoko/` and `.env` files.

## A step

One step per file under `features/steps/`. The file name is the step name (`an-item-exists.ts` is `an-item-exists`).

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

- `args` and `returns` are zod objects; `z` is re-exported from `nukadoko`, so a project needs no zod of its own.
- The first argument of `run` (or `observe`, in a Then step) is destructured, and the names it takes are the fixtures the step needs. `nuka check` reads them without calling the body.
- `from: { body: [createItem, "body"] }` fills an args key from what an earlier step returned; the step is imported, so a rename is a type error.
- A Then step declares `claims` and an `observe` that reads the world. nukadoko judges the claims.
- `defineFixtures` in `nukadoko.config.ts` adds a project fixture, and `use()` marks where its teardown starts.

## Commands

The commands and their flags are the same as the Ruby engine's, except `nuka sig`, which only the gem has; the [table in the project README](https://github.com/meganemura/nukadoko#install) lists each command and flag for both.

## Development

The engine lives in `typescript/` of the repository. [CONTRIBUTING.md](https://github.com/meganemura/nukadoko/blob/main/CONTRIBUTING.md) has the setup and the commands.

[日本語](README.ja.md)
