// @ts-nocheck
// esbuild flags the redeclaration below as an early ECMAScript error before
// this step's own body ever runs (redeclaring a fixture-bag name directly
// under the function is independently treated as an early error by
// esbuild, tsc, and @babel/parser alike). The `@ts-nocheck` above is what
// keeps this file out of `npm run typecheck`'s own complaint about the same
// redeclaration (TS2451): esbuild still runs its own transform on `.ts`
// regardless of this pragma (measured directly), so the import failure
// this fixture exists to produce survives untouched. via-import.ts, right
// beside this file, side-effect imports this module and gets the identical
// rethrown error — this file's own path is what its message names either
// way.
import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";

export default defineStep({
  pattern: "something happens",
  description: "never runs: the file fails to import",
  args: z.object({}),
  returns: z.object({ ok: z.boolean() }),
  mutates: false,
  async run({ page }) {
    const page = 1;
    return { ok: page === 1 };
  },
});
