import { z } from "zod";
import { defineStep } from "../../nukadoko-shim.js";
import createListing from "./create-listing.js";

// fb3-used-result task spec: reads the upstream listing via `ctx.resultOf`,
// then always fails — the `ctx.resultOf` counterpart to from-project's own
// archive-project-fails.ts, proving the same result-on-failed-`used`
// behavior holds for a `ctx.resultOf` read, not only a `from` injection.
export default defineStep({
  pattern: "closing that listing explodes",
  description: "Reads the listing via ctx.resultOf, then always fails",
  args: z.object({}),
  returns: z.object({ closed: z.boolean() }),
  mutates: false,
  async run({ resultOf }) {
    resultOf(createListing);
    throw new Error("closing exploded on purpose");
  },
});
