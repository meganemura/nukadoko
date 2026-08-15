import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import createListing from "./create-listing.js";

// The chain's consumer side: imports
// the producer step module directly and passes the object itself to
// `ctx.resultOf` — the dependency is a visible `import` (docs/spec.md
// "Context API"). This file existing and working at all *is* this task's
// empirical proof that a step file's relative import of another step file
// resolves to the exact same Step object discovery's own `tsImport` call
// produced — if identity didn't survive that boundary, every test below
// relying on a non-null `resultOf` return would fail.
//
// No `args` are needed to say *which* listing: the whole point of the chain
// is that "that listing" resolves through the import, not through a name the
// caller has to thread through — this also lets `nuka do` invoke this step
// directly with `--args '{}'` to prove resultOf is always `undefined` there.
export default defineStep({
  pattern: "that listing is closed",
  description: "Reads the most recently created listing via resultOf and reports its name",
  args: z.object({}),
  returns: z.object({ closed: z.boolean(), name: z.string().nullable() }),
  mutates: false,
  async run({ resultOf }) {
    const listing = resultOf(createListing);
    return { closed: listing !== undefined, name: listing?.name ?? null };
  },
});
